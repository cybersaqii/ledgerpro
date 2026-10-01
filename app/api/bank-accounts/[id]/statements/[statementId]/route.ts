import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts, bankStatementLines, bankStatements } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import {
  autoMatchStatement,
  deleteBankStatement,
  manualMatchStatementLine,
  unmatchStatementLines,
} from "@/lib/statements";
import { getRecLines, recBalances, unclearedNetOf } from "@/lib/reconciliation";

type Ctx = { params: Promise<{ id: string; statementId: string }> };

type LoadedStatement =
  | { error: string }
  | { bank: typeof bankAccounts.$inferSelect; statement: typeof bankStatements.$inferSelect };

async function loadStatement(companyId: string, bankId: string, statementId: string): Promise<LoadedStatement> {
  const bankRows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankId), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!bankRows[0]) return { error: "Bank account not found." as const };
  const stRows = await db
    .select()
    .from(bankStatements)
    .where(
      and(
        eq(bankStatements.id, statementId),
        eq(bankStatements.companyId, companyId),
        eq(bankStatements.bankAccountId, bankId)
      )
    )
    .limit(1);
  if (!stRows[0]) return { error: "Statement not found." as const };
  return { bank: bankRows[0], statement: stRows[0] };
}

// GET — statement detail: lines + match state + reconciled status.
// Reconciled ⟺ every non-duplicate line is matched AND book−cleared difference is 0.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id, statementId } = await ctx.params;
  const loaded = await loadStatement(companyId, id, statementId);
  if ("error" in loaded) return err(loaded.error, 404);
  const { bank, statement } = loaded;

  const lines = await db
    .select()
    .from(bankStatementLines)
    .where(
      and(eq(bankStatementLines.statementId, statementId), eq(bankStatementLines.companyId, companyId))
    )
    .orderBy(bankStatementLines.date);

  const allGl = await getRecLines(db, companyId, { id: bank.id, accountId: bank.accountId }, {});
  const unclearedNet = unclearedNetOf(allGl);
  const { difference } = recBalances(bank.balance, unclearedNet);
  const allMatched = lines.filter((l) => !l.isDuplicate).every((l) => l.matchedJournalLineId != null);

  return json({
    data: {
      statement: {
        id: statement.id,
        fileName: statement.fileName,
        lineCount: statement.lineCount,
        openingBalance: statement.openingBalance.toString(),
        closingBalance: statement.closingBalance == null ? null : statement.closingBalance.toString(),
        createdAt: (statement.createdAt as unknown as Date).getTime(),
      },
      account: { id: bank.id, name: bank.name, kind: bank.kind },
      lines: lines.map((l) => ({
        id: l.id,
        date: (l.date as unknown as Date).getTime(),
        description: l.description,
        reference: l.reference,
        debit: l.debit.toString(),
        credit: l.credit.toString(),
        amount: l.amount.toString(),
        isDuplicate: !!l.isDuplicate,
        matchedJournalLineId: l.matchedJournalLineId,
        createdTxnType: l.createdTxnType,
        createdTxnId: l.createdTxnId,
      })),
      matchedCount: lines.filter((l) => l.matchedJournalLineId != null).length,
      reconciled: allMatched && difference === 0n,
      difference: difference.toString(),
      // Module 3: uncleared book-side entries the UI can offer for manual matching.
      glLines: allGl
        .filter((l) => l.clearedAt == null)
        .map((l) => ({
          lineId: l.lineId,
          date: l.date,
          memo: l.memo,
          reference: l.reference,
          amount: (l.debit - l.credit).toString(),
        })),
    },
  });
}

const actionSchema = z.union([
  z.object({ action: z.literal("auto-match") }),
  z.object({ action: z.literal("match"), lineId: z.string().min(1), journalLineId: z.string().min(1) }),
  z.object({ action: z.literal("unmatch"), lineIds: z.array(z.string().min(1)).min(1).max(500) }),
]);

// POST — { action: "auto-match" } | { action: "match", lineId, journalLineId } |
//        { action: "unmatch", lineIds }
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id, statementId } = await ctx.params;
  const loaded = await loadStatement(companyId, id, statementId);
  if ("error" in loaded) return err(loaded.error, 404);

  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return err("Please check the selection and try again.", 422);

  try {
    const result = await db.transaction(async (tx) => {
      if (parsed.data.action === "auto-match") {
        return { ...(await autoMatchStatement(tx, companyId, statementId, session.uid)), action: "auto-match" as const };
      }
      if (parsed.data.action === "match") {
        await manualMatchStatementLine(tx, companyId, parsed.data.lineId, parsed.data.journalLineId, session.uid);
        return { action: "match" as const, count: 1 };
      }
      const r = await unmatchStatementLines(tx, companyId, parsed.data.lineIds);
      return { action: "unmatch" as const, count: r.count };
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "bank.statement_matched", entity: "bank_statement", entityId: statementId,
      detail: `Statement matching (${parsed.data.action}) on "${loaded.bank.name}"`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/statements/[statementId]", companyId });
  }
}

// DELETE — remove an import session and its lines (auto-match clears are removed too).
export async function DELETE(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id, statementId } = await ctx.params;
  const loaded = await loadStatement(companyId, id, statementId);
  if ("error" in loaded) return err(loaded.error, 404);

  try {
    await db.transaction((tx) => deleteBankStatement(tx, companyId, statementId));
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "bank.statement_deleted", entity: "bank_statement", entityId: statementId,
      detail: `Statement "${loaded.statement.fileName}" deleted from "${loaded.bank.name}"`,
    });
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/statements/[statementId]", companyId });
  }
}
