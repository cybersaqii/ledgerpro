import { eq, and, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import type { Db } from "@/lib/db";

/** Date range filter (inclusive from, exclusive to+1day), or null for all time. */
export function dateRange(from?: string | null, to?: string | null) {
  const conds = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }
  return conds;
}

/** Sum of debits/credits per account code for a company (+ optional date range). */
export async function glSums(
  db: Db,
  companyId: string,
  from?: string | null,
  to?: string | null
): Promise<Map<string, { debit: bigint; credit: bigint; name: string; type: string }>> {
  const rows = await db
    .select({
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      d: sql<string>`COALESCE(SUM(${journalLines.debit}),0)`,
      c: sql<string>`COALESCE(SUM(${journalLines.credit}),0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(eq(journalEntries.companyId, companyId), ...dateRange(from, to)))
    .groupBy(accounts.code, accounts.name, accounts.type);
  const map = new Map<string, { debit: bigint; credit: bigint; name: string; type: string }>();
  for (const r of rows) {
    map.set(r.code, {
      debit: BigInt(r.d),
      credit: BigInt(r.c),
      name: r.name,
      type: r.type,
    });
  }
  return map;
}

/** Net balance of one account code: debit-normal accounts return d-c, credit-normal return c-d. */
export function netOf(
  sums: Map<string, { debit: bigint; credit: bigint }>,
  code: string,
  creditNormal = false
): bigint {
  const s = sums.get(code);
  if (!s) return 0n;
  return creditNormal ? s.credit - s.debit : s.debit - s.credit;
}

/** Net total of all accounts of a given type (debit-normal math), excluding codes. */
export function sumByType(
  sums: Map<string, { debit: bigint; credit: bigint; type: string }>,
  type: string,
  exclude: string[] = []
): bigint {
  let total = 0n;
  for (const [code, s] of sums) {
    if (s.type === type && !exclude.includes(code)) total += s.debit - s.credit;
  }
  return total;
}

/** Net total of all accounts of a given type with credit-normal math, excluding codes. */
export function sumByTypeCredit(
  sums: Map<string, { debit: bigint; credit: bigint; type: string }>,
  type: string,
  exclude: string[] = []
): bigint {
  let total = 0n;
  for (const [code, s] of sums) {
    if (s.type === type && !exclude.includes(code)) total += s.credit - s.debit;
  }
  return total;
}
