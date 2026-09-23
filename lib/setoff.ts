import { eq, and, sql, asc, inArray } from "drizzle-orm";
import { parties, salesDocs, purchaseDocs, setoffAllocations } from "@/db/schema";
import { createJournal } from "./posting";
import { SYS, accountMap } from "./setup";
import type { DbTx } from "./db";
import { UserError } from "./errors";

export type SetoffInput = {
  companyId: string;
  branchId: string;
  customerId: string;
  supplierId: string;
  amount: bigint; // paisa, positive
  date: Date;
  notes?: string;
  createdById: string;
};

/**
 * Set-off (contra) — nets a party that is both customer and supplier.
 *
 * Journal: Dr Accounts Payable / Cr Accounts Receivable, each line tagged
 * with the respective party so the party ledgers move correctly.
 * Both party balances drop by the amount; the entry is fully balanced.
 */
export async function postSetoff(tx: DbTx, input: SetoffInput): Promise<string> {
  if (input.amount <= 0n) throw new UserError("Set-off amount must be positive.");
  if (input.customerId === input.supplierId) throw new UserError("Customer and supplier must be different parties.");

  const [customer] = await tx
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, input.customerId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const [supplier] = await tx
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, input.supplierId), eq(parties.companyId, input.companyId)))
    .limit(1);
  if (!customer) throw new UserError("Customer not found.");
  if (!supplier) throw new UserError("Supplier not found.");
  if (customer.kind !== "CUSTOMER") throw new UserError("First party must be a customer.");
  if (supplier.kind !== "SUPPLIER") throw new UserError("Second party must be a supplier.");

  const custBal = BigInt(customer.balance); // +ve = they owe us
  const suppBal = BigInt(supplier.balance); // +ve = we owe them
  if (custBal <= 0n) throw new UserError(`${customer.name} has no receivable to set off.`);
  if (suppBal <= 0n) throw new UserError(`${supplier.name} has no payable to set off.`);
  const max = custBal < suppBal ? custBal : suppBal;
  if (input.amount > max) throw new UserError(`Set-off cannot exceed Rs ${(max / 100n).toLocaleString()} (the smaller balance).`);

  const ac = await accountMap(tx, input.companyId);
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Set-off: ${customer.name} ↔ ${supplier.name}${input.notes ? ` — ${input.notes}` : ""}`,
    source: "SETOFF",
    createdById: input.createdById,
    lines: [
      { accountId: ac[SYS.AP], debit: input.amount, credit: 0n, partyId: supplier.id },
      { accountId: ac[SYS.AR], debit: 0n, credit: input.amount, partyId: customer.id },
    ],
  });

  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, customer.id));
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, supplier.id));

  // M2: a set-off settles documents, not just GL balances. Allocate the amount
  // against the oldest open invoices/bills so aging and the party ledger agree
  // with the journal. Any remainder (no open docs left) stays as party-level
  // credit, exactly like an unallocated payment.
  await settleOpenDocs(tx, input.companyId, entryId, customer.id, "SALES", input.amount);
  await settleOpenDocs(tx, input.companyId, entryId, supplier.id, "PURCHASE", input.amount);

  return entryId;
}

/**
 * Allocate a set-off amount against a party's oldest open documents.
 * Mirrors the allocation bookkeeping in postPayment (amountPaid + status),
 * linked to the SETOFF journal entry instead of a payment row.
 */
async function settleOpenDocs(
  tx: DbTx,
  companyId: string,
  entryId: string,
  partyId: string,
  side: "SALES" | "PURCHASE",
  amount: bigint
): Promise<void> {
  let remaining = amount;
  if (side === "SALES") {
    const docs = await tx
      .select({
        id: salesDocs.id,
        docNo: salesDocs.docNo,
        grandTotal: salesDocs.grandTotal,
        amountPaid: salesDocs.amountPaid,
        returnedTotal: salesDocs.returnedTotal,
      })
      .from(salesDocs)
      .where(
        and(
          eq(salesDocs.companyId, companyId),
          eq(salesDocs.partyId, partyId),
          eq(salesDocs.docType, "INVOICE"),
          inArray(salesDocs.status, ["POSTED", "PARTIAL"])
        )
      )
      .orderBy(asc(salesDocs.date), asc(salesDocs.createdAt));
    for (const d of docs) {
      if (remaining <= 0n) break;
      const gt = d.grandTotal as bigint, ap = d.amountPaid as bigint, rt = d.returnedTotal as bigint;
      const open = gt - ap - rt;
      if (open <= 0n) continue;
      const take = open < remaining ? open : remaining;
      const paid = ap + take;
      await tx
        .update(salesDocs)
        .set({ amountPaid: paid, status: paid >= gt - rt ? "PAID" : "PARTIAL", updatedAt: new Date() })
        .where(eq(salesDocs.id, d.id));
      await tx.insert(setoffAllocations).values({
        id: crypto.randomUUID(),
        companyId,
        setoffEntryId: entryId,
        partyId,
        salesDocId: d.id,
        amount: take,
      });
      remaining -= take;
    }
  } else {
    const docs = await tx
      .select({
        id: purchaseDocs.id,
        docNo: purchaseDocs.docNo,
        grandTotal: purchaseDocs.grandTotal,
        amountPaid: purchaseDocs.amountPaid,
        returnedTotal: purchaseDocs.returnedTotal,
      })
      .from(purchaseDocs)
      .where(
        and(
          eq(purchaseDocs.companyId, companyId),
          eq(purchaseDocs.partyId, partyId),
          eq(purchaseDocs.docType, "BILL"),
          inArray(purchaseDocs.status, ["POSTED", "PARTIAL"])
        )
      )
      .orderBy(asc(purchaseDocs.date), asc(purchaseDocs.createdAt));
    for (const d of docs) {
      if (remaining <= 0n) break;
      const gt = d.grandTotal as bigint, ap = d.amountPaid as bigint, rt = d.returnedTotal as bigint;
      const open = gt - ap - rt;
      if (open <= 0n) continue;
      const take = open < remaining ? open : remaining;
      const paid = ap + take;
      await tx
        .update(purchaseDocs)
        .set({ amountPaid: paid, status: paid >= gt - rt ? "PAID" : "PARTIAL", updatedAt: new Date() })
        .where(eq(purchaseDocs.id, d.id));
      await tx.insert(setoffAllocations).values({
        id: crypto.randomUUID(),
        companyId,
        setoffEntryId: entryId,
        partyId,
        purchaseDocId: d.id,
        amount: take,
      });
      remaining -= take;
    }
  }
}
