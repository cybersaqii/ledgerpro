import { NextRequest } from "next/server";
import { eq, and, sql, desc } from "drizzle-orm";
import { partners, journalLines, journalEntries, accounts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/partners/[id]/ledger?account=capital|current — partner ledger entries
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const which = req.nextUrl.searchParams.get("account") === "current" ? "current" : "capital";

  const rows = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, id), eq(partners.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p) return err("Partner not found.", 404);

  const accountId = which === "capital" ? p.capitalAccountId : p.currentAccountId;
  const lines = await db
    .select({
      id: journalLines.id,
      date: journalEntries.date,
      memo: journalEntries.memo,
      debit: journalLines.debit,
      credit: journalLines.credit,
      docNo: journalEntries.docNo,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.companyId, companyId), eq(journalLines.accountId, accountId)))
    .orderBy(desc(journalEntries.date));

  let running = 0n;
  const entries = lines.map((l) => {
    // EQUITY: credit increases. Balance = Σ(credit − debit).
    running += BigInt(l.credit) - BigInt(l.debit);
    return {
      ...l,
      debit: BigInt(l.debit).toString(),
      credit: BigInt(l.credit).toString(),
      balance: running.toString(),
    };
  });

  const acct = await db
    .select({ code: accounts.code, name: accounts.name })
    .from(accounts)
    .where(eq(accounts.id, accountId))
    .limit(1);

  return json({ data: { partner: p, account: acct[0], which, entries } });
}
