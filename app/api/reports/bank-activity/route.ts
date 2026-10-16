import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { bankAccounts, journalEntries, journalLines } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/bank-activity?from=&to=&accountId=
// Per bank/cash account: opening balance, total received (debits), total paid
// (credits) and closing balance for the period.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from")?.trim() || "";
  const to = sp.get("to")?.trim() || "";
  const accountId = sp.get("accountId")?.trim() || "";

  const bankConds = [eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)];
  if (accountId) bankConds.push(eq(bankAccounts.id, accountId));
  const banks = await db
    .select()
    .from(bankAccounts)
    .where(and(...bankConds))
    .orderBy(bankAccounts.name);

  const fromMs = /^\d{4}-\d{2}-\d{2}$/.test(from) ? Date.parse(`${from}T00:00:00Z`) : NaN;
  const toMs = /^\d{4}-\d{2}-\d{2}$/.test(to) ? Date.parse(`${to}T00:00:00Z`) : NaN;
  const hasFrom = !isNaN(fromMs);
  const hasTo = !isNaN(toMs);

  async function sums(glIds: string[], before: boolean) {
    const conds = [
      eq(journalEntries.companyId, companyId),
      inArray(journalLines.accountId, glIds),
    ];
    if (before && hasFrom) conds.push(sql`${journalEntries.date} < ${fromMs}`);
    if (!before) {
      if (hasFrom) conds.push(sql`${journalEntries.date} >= ${fromMs}`);
      if (hasTo) conds.push(sql`${journalEntries.date} < ${toMs + 86400000}`);
    }
    const rows = await db
      .select({
        d: sql<string>`COALESCE(SUM(${journalLines.debit}),0)`,
        c: sql<string>`COALESCE(SUM(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(and(...conds));
    const r = rows[0];
    return { debit: BigInt(r?.d ?? 0), credit: BigInt(r?.c ?? 0) };
  }

  const data = [];
  let tOpening = 0n, tIn = 0n, tOut = 0n, tClosing = 0n;
  for (const b of banks) {
    const glIds = [b.accountId];
    const open = await sums(glIds, true);
    const period = await sums(glIds, false);
    const opening = open.debit - open.credit;
    const received = period.debit;
    const paid = period.credit;
    const closing = opening + received - paid;
    tOpening += opening; tIn += received; tOut += paid; tClosing += closing;
    data.push({
      id: b.id,
      name: b.name,
      kind: b.kind,
      opening: opening.toString(),
      received: received.toString(),
      paid: paid.toString(),
      closing: closing.toString(),
    });
  }

  return json({
    data,
    totals: {
      opening: tOpening.toString(),
      received: tIn.toString(),
      paid: tOut.toString(),
      closing: tClosing.toString(),
    },
    banks: banks.map((b) => ({ id: b.id, name: b.name })),
    from,
    to,
    accountId,
  });
}
