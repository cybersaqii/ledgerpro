import { NextRequest } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts, journalEntries, journalLines, reconciliationClears } from "@/db/schema";

import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { getRecLines, recBalances, unclearedNetOf } from "@/lib/reconciliation";

// GET /api/bank-accounts/[id]/reconciliation?from=&to=&onlyUncleared=1
// Lists every journal line touching the account's GL account with its cleared
// state, plus the book-vs-cleared balance header. Clearing never alters the
// posted amounts — it only records which lines the bank statement matches.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;

  const ba = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!ba[0]) return err("Bank account not found.", 404);
  const bank = ba[0];

  const sp = req.nextUrl.searchParams;
  const onlyUncleared = sp.get("onlyUncleared") !== "0";
  let fromMs: number | undefined;
  let toMs: number | undefined;
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) fromMs = t;
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) toMs = t + 86400000;
  }

  const lines = await getRecLines(db, companyId, bank, { fromMs, toMs, onlyUncleared });
  // Uncleared net is global (not date-filtered): the header compares the
  // full book balance against everything still uncleared.
  const allLines = onlyUncleared || fromMs != null || toMs != null
    ? await getRecLines(db, companyId, bank, {})
    : lines;
  const unclearedNet = unclearedNetOf(allLines);
  const { clearedBalance, difference } = recBalances(bank.balance, unclearedNet);

  return json({
    data: {
      account: { id: bank.id, name: bank.name, kind: bank.kind, bankName: bank.bankName, accountNo: bank.accountNo },
      lines: lines.map((l) => ({
        lineId: l.lineId,
        entryId: l.entryId,
        date: l.date,
        memo: l.memo,
        reference: l.reference,
        source: l.source,
        partyName: l.partyName,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        clearedAt: l.clearedAt,
        suggestedClearedAt: l.suggestedClearedAt,
      })),
      bookBalance: bank.balance.toString(),
      clearedBalance: clearedBalance.toString(),
      difference: difference.toString(),
      clearedCount: allLines.filter((l) => l.clearedAt != null).length,
      totalCount: allLines.length,
    },
  });
}

const clearSchema = z.object({
  action: z.enum(["clear", "unclear"]),
  lineIds: z.array(z.string().min(1)).min(1).max(500),
  clearedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// POST /api/bank-accounts/[id]/reconciliation
// { action: "clear", lineIds, clearedAt } marks lines cleared on the bank's
// date; { action: "unclear", lineIds } removes the mark. PDC lines cleared
// through the PDC register carry their own cleared date as the suggestion.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;

  const ba = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!ba[0]) return err("Bank account not found.", 404);
  const bank = ba[0];

  const body = await req.json().catch(() => null);
  const parsed = clearSchema.safeParse(body);
  if (!parsed.success) return err("Please check the selection and try again.", 422);
  const { action, lineIds } = parsed.data;

  let clearedMs: number | null = null;
  if (action === "clear") {
    if (!parsed.data.clearedAt) return err("Cleared date is required.", 422);
    try {
      clearedMs = parseDateOnly(parsed.data.clearedAt).getTime();
    } catch {
      return err("Cleared date is invalid.", 422);
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      // Guard: every line must be a journal line of THIS account's GL account.
      const guardRows = await tx
        .select({ id: journalLines.id })
        .from(journalLines)
        .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
        .where(
          and(
            eq(journalLines.accountId, bank.accountId),
            eq(journalEntries.companyId, companyId),
            inArray(journalLines.id, lineIds)
          )
        );
      const valid = new Set(guardRows.map((r) => r.id));
      const bad = lineIds.filter((x) => !valid.has(x));
      if (bad.length > 0) throw new Error("Some selected entries do not belong to this account.");

      if (action === "clear") {
        const clearedDate = new Date(clearedMs!);
        for (const lineId of lineIds) {
          await tx
            .insert(reconciliationClears)
            .values({
              id: crypto.randomUUID(),
              companyId,
              bankAccountId: bank.id,
              journalLineId: lineId,
              clearedAt: clearedDate,
              clearedById: session.uid,
              createdAt: new Date(),
            })
            .onConflictDoUpdate({
              target: reconciliationClears.journalLineId,
              set: { clearedAt: clearedDate, clearedById: session.uid },
            });
        }
      } else {
        await tx
          .delete(reconciliationClears)
          .where(
            and(
              eq(reconciliationClears.companyId, companyId),
              eq(reconciliationClears.bankAccountId, bank.id),
              inArray(reconciliationClears.journalLineId, lineIds)
            )
          );
      }
      return { count: lineIds.length };
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: action === "clear" ? "bank.reconciled" : "bank.unreconciled",
      entity: "bank_account", entityId: bank.id,
      detail: `${result.count} entr${result.count === 1 ? "y" : "ies"} ${action === "clear" ? "cleared" : "uncleared"} on "${bank.name}"`,
    });
    return json({ ok: true, count: result.count });
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/reconciliation", companyId });
  }
}
