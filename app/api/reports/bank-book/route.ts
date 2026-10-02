import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { bankAccounts, journalEntries, journalLines, parties } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/bank-book?accountId=&from=&to=
// Cash/bank account ledger: opening balance + every journal line touching the
// account's GL account, with a running balance.
// accountId=all merges every cash/bank account into one combined ledger.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const accountId = sp.get("accountId");
  if (!accountId) return err("accountId is required.", 422);
  const from = sp.get("from");
  const to = sp.get("to");

  const showAll = accountId === "all";
  let glAccountIds: string[];
  let accountNameByGl = new Map<string, string>();
  let account: { id: string; name: string; kind: string; bankName: string | null; accountNo: string | null };

  if (showAll) {
    const allBanks = await db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)));
    glAccountIds = allBanks.map((b) => b.accountId);
    accountNameByGl = new Map(allBanks.map((b) => [b.accountId, b.name]));
    // The page localizes the "All accounts" label via bankbook.allAccounts.
    account = { id: "all", name: "", kind: "ALL", bankName: null, accountNo: null };
  } else {
    const ba = await db
      .select()
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, accountId), eq(bankAccounts.companyId, companyId)))
      .limit(1);
    if (!ba[0]) return err("Account not found.", 404);
    const bank = ba[0];
    glAccountIds = [bank.accountId];
    accountNameByGl = new Map([[bank.accountId, bank.name]]);
    account = {
      id: bank.id,
      name: bank.name,
      kind: bank.kind,
      bankName: bank.bankName,
      accountNo: bank.accountNo,
    };
  }

  if (glAccountIds.length === 0) {
    return json({ account, opening: "0", entries: [], closing: "0", from, to });
  }

  const dateConds = [];
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} >= ${t}`);
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) dateConds.push(sql`${journalEntries.date} < ${t + 86400000}`);
  }

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
            inArray(journalLines.accountId, glAccountIds),
            sql`${journalEntries.date} < ${t}`
          )
        );
      const r = rows[0];
      opening = r ? BigInt(r.d) - BigInt(r.c) : 0n;
    }
  }

  const lines = await db
    .select({
      date: journalEntries.date,
      memo: journalEntries.memo,
      reference: journalEntries.reference,
      source: journalEntries.source,
      sourceId: journalEntries.sourceId,
      partyName: parties.name,
      glAccountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .leftJoin(parties, eq(journalLines.partyId, parties.id))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        inArray(journalLines.accountId, glAccountIds),
        ...dateConds
      )
    )
    .orderBy(journalEntries.date, journalEntries.createdAt);

  let running = opening;
  const entries = lines.map((l) => {
    running += l.debit - l.credit;
    return {
      date: l.date,
      memo: l.memo,
      reference: l.reference,
      source: l.source,
      sourceId: l.sourceId,
      partyName: l.partyName,
      accountName: accountNameByGl.get(l.glAccountId) ?? null,
      debit: l.debit.toString(),
      credit: l.credit.toString(),
      balance: running.toString(),
    };
  });

  return json({
    account,
    opening: opening.toString(),
    entries,
    closing: running.toString(),
    from,
    to,
  });
}
