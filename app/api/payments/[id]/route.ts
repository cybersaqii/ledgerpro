import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import {
  bankAccounts,
  parties,
  paymentAllocations,
  payments,
  purchaseDocs,
  salesDocs,
} from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/payments/[id] — payment detail with per-document allocation breakdown
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;
  try {
    const rows = await db
      .select({ p: payments, partyName: parties.name, bankName: bankAccounts.name })
      .from(payments)
      .leftJoin(parties, eq(payments.partyId, parties.id))
      .leftJoin(bankAccounts, eq(payments.bankAccountId, bankAccounts.id))
      .where(eq(payments.id, id));
    const row = rows[0];
    if (!row || row.p.companyId !== companyId) return err("Payment not found.", 404);

    const allocs = await db
      .select({ a: paymentAllocations, s: salesDocs, b: purchaseDocs })
      .from(paymentAllocations)
      .leftJoin(salesDocs, eq(paymentAllocations.salesDocId, salesDocs.id))
      .leftJoin(purchaseDocs, eq(paymentAllocations.purchaseDocId, purchaseDocs.id))
      .where(eq(paymentAllocations.paymentId, id));

    const allocations = allocs.map(({ a, s, b }) => {
      const doc = s ?? b;
      const grandTotal = doc?.grandTotal ?? 0n;
      const amountPaid = doc?.amountPaid ?? 0n;
      const returnedTotal = doc?.returnedTotal ?? 0n;
      return {
        id: a.id,
        docId: doc?.id ?? null,
        docNo: doc?.docNo ?? "—",
        docType: doc?.docType ?? null,
        docKind: s ? "SALES" : "PURCHASE",
        date: doc?.date ?? null,
        docTotal: grandTotal.toString(),
        adjusted: a.amount.toString(),
        balance: (grandTotal - amountPaid - returnedTotal).toString(),
      };
    });

    // Void markers live outside db/schema.ts (migration 0027) — read raw.
    const voidRows = (
      await db.run(
        sql`SELECT voided_at AS v, void_journal_entry_id AS j FROM payments WHERE id = ${id}`
      )
    ).rows as unknown as { v: number | null; j: string | null }[];
    const voidedAt = voidRows[0]?.v ?? null;

    return json({
      data: { ...row.p, partyName: row.partyName, bankName: row.bankName, allocations, voidedAt, voidJournalEntryId: voidRows[0]?.j ?? null },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/payments/[id]", companyId });
  }
}
