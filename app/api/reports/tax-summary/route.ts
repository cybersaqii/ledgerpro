import { NextRequest } from "next/server";
import { eq, and, sql, type SQLWrapper } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { SYS } from "@/lib/setup";

// GET /api/reports/tax-summary?from=&to=
// GST position for a period: tax collected on sales (TAX_PAYABLE credits)
// vs input tax paid on purchases (INPUT_TAX debits), and the net payable.
// Account codes come from SYS, never hardcoded.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("advanced_reports");
  if (!pro.ok) return pro.response;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const accRows = await db
    .select({ id: accounts.id, code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.companyId, companyId));
  const byCode = new Map(accRows.map((a) => [a.code, a]));
  const payableAcc = byCode.get(SYS.TAX_PAYABLE);
  const inputAcc = byCode.get(SYS.INPUT_TAX);

  const dateConds: SQLWrapper[] = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }

  async function sums(accountId: string | undefined) {
    if (!accountId) return { debit: 0n, credit: 0n };
    const rows = await db
      .select({
        d: sql<string>`COALESCE(SUM(${journalLines.debit}),0)`,
        c: sql<string>`COALESCE(SUM(${journalLines.credit}),0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          eq(journalLines.accountId, accountId),
          ...dateConds
        )
      );
    const r = rows[0];
    return { debit: BigInt(r?.d ?? "0"), credit: BigInt(r?.c ?? "0") };
  }

  const collected = await sums(payableAcc?.id); // credits = GST on sales
  const paid = await sums(inputAcc?.id); // debits = input tax on purchases
  const netCollected = collected.credit - collected.debit;
  const netPaid = paid.debit - paid.credit;
  const netPayable = netCollected - netPaid;
  const s = (v: bigint) => v.toString();

  return json({
    from,
    to,
    collected: {
      account: payableAcc ? { code: payableAcc.code, name: payableAcc.name } : null,
      debit: s(collected.debit),
      credit: s(collected.credit),
      net: s(netCollected),
    },
    paid: {
      account: inputAcc ? { code: inputAcc.code, name: inputAcc.name } : null,
      debit: s(paid.debit),
      credit: s(paid.credit),
      net: s(netPaid),
    },
    netPayable: s(netPayable),
  });
}
