import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/account-ledger?accountId=&from=&to=
// General-ledger drilldown for one account: opening balance + every journal
// line on the account, with a running balance. Credit-normal accounts
// (liability/equity/income) show the balance as credit-positive.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  if (!accountId) return err("accountId is required.", 422);
  const from = sp.get("from");
  const to = sp.get("to");

  const ar = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId)))
    .limit(1);
  if (!ar[0]) return err("Account not found.", 404);
  const account = ar[0];
  const creditNormal = account.type === "LIABILITY" || account.type === "EQUITY" || account.type === "INCOME";

  const dateConds = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }

  // Opening: net of all lines before `from`, in the account's normal direction.
  let opening = 0n;
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) {
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
            sql`${journalEntries.date} < ${t}`
          )
        );
      const r = rows[0];
      if (r) opening = creditNormal ? BigInt(r.c) - BigInt(r.d) : BigInt(r.d) - BigInt(r.c);
    }
  }

  const lines = await db
    .select({
      date: journalEntries.date,
      memo: journalEntries.memo,
      reference: journalEntries.reference,
      docNo: journalEntries.docNo,
      source: journalEntries.source,
      sourceId: journalEntries.sourceId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(journalLines.accountId, accountId), ...dateConds))
    .orderBy(journalEntries.date, journalEntries.createdAt);

  let running = opening;
  const entries = lines.map((l) => {
    running += creditNormal ? l.credit - l.debit : l.debit - l.credit;
    return {
      date: l.date,
      memo: l.memo,
      reference: l.reference,
      docNo: l.docNo,
      source: l.source,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      balance: running.toString(),
    };
  });

  return json({
    account: { id: account.id, code: account.code, name: account.name, type: account.type, creditNormal },
    opening: opening.toString(),
    entries,
    closing: running.toString(),
    from,
    to,
  });
}
