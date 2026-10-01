import { eq, and, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalLines,
  parties,
  payments,
  paymentAllocations,
  purchaseDocs,
  salesDocs,
  expenses,
  sundryReceipts,
  whtDeductions,
} from "@/db/schema";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { DbTx } from "./db";
import { FIX3_SOURCES } from "./stock-adjust";

/** Recompute a doc's payment status after its amountPaid changes. */
function statusAfterPaid(amountPaid: bigint, grandTotal: bigint, returnedTotal: bigint): string {
  const net = grandTotal - returnedTotal;
  if (amountPaid >= net) return "PAID";
  if (amountPaid > 0n) return "PARTIAL";
  return "UNPAID";
}

/** Allocation rows created strictly after the payment's own posting window. */
async function laterAllocationRows(
  tx: DbTx,
  paymentId: string,
  paymentCreatedAt: Date,
  graceMs: number
): Promise<{ id: string; docNo: string }[]> {
  const rows = await tx
    .select({
      id: paymentAllocations.id,
      createdAt: paymentAllocations.createdAt,
      salesDocId: paymentAllocations.salesDocId,
      purchaseDocId: paymentAllocations.purchaseDocId,
    })
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, paymentId));
  const cutoff = paymentCreatedAt.getTime() + graceMs;
  const out: { id: string; docNo: string }[] = [];
  for (const r of rows) {
    if ((r.createdAt as unknown as Date).getTime() <= cutoff) continue;
    const docId = r.salesDocId ?? r.purchaseDocId;
    let docNo = "—";
    if (r.salesDocId) {
      const d = await tx.select({ docNo: salesDocs.docNo }).from(salesDocs).where(eq(salesDocs.id, docId!)).limit(1);
      docNo = d[0]?.docNo ?? "—";
    } else if (r.purchaseDocId) {
      const d = await tx.select({ docNo: purchaseDocs.docNo }).from(purchaseDocs).where(eq(purchaseDocs.id, docId!)).limit(1);
      docNo = d[0]?.docNo ?? "—";
    }
    out.push({ id: r.id, docNo });
  }
  return out;
}

export type VoidPaymentInput = {
  companyId: string;
  paymentId: string;
  reason?: string;
  userId: string;
};

/**
 * G4 — void a payment. Never hard-deletes: posts an exact REVERSING journal
 * (same accounts, swapped debits/credits), releases every allocation
 * (decrements each doc's amountPaid/status), restores party + bank balances,
 * and stamps the payment as voided with an audit link to the reversal.
 *
 * Blocked when:
 *  - the payment is already voided;
 *  - the original payment date or the void date falls in a locked period;
 *  - any of the payment's credit was consumed later (advance auto-application
 *    attaches allocation rows after posting) — the consuming invoices must be
 *    corrected first. Free the credit with Unallocate, or void from the
 *    invoice side, then void the payment.
 */
export async function voidPayment(
  tx: DbTx,
  input: VoidPaymentInput
): Promise<{ voidJournalEntryId: string }> {
  const pr = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, input.paymentId), eq(payments.companyId, input.companyId)))
    .limit(1);
  const payment = pr[0];
  if (!payment) throw new UserError("Payment not found.");
  const voidedAt = (
    await tx.run(sql`SELECT voided_at AS v FROM payments WHERE id = ${payment.id}`)
  ).rows[0] as unknown as { v: number | null } | undefined;
  if (voidedAt?.v) throw new UserError("This payment is already voided.");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, payment.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  const consumed = await laterAllocationRows(tx, payment.id, payment.createdAt, 60_000);
  if (consumed.length > 0) {
    const docs = consumed.map((c) => c.docNo).join(", ");
    throw new UserError(
      `This payment's credit was consumed by ${docs}. Void or correct those invoices first, then void this payment.`
    );
  }

  const partyRows = await tx
    .select({ kind: parties.kind })
    .from(parties)
    .where(and(eq(parties.id, payment.partyId!), eq(parties.companyId, input.companyId)))
    .limit(1);
  const isCustomer = partyRows[0]?.kind === "CUSTOMER";
  const isReceipt = payment.kind === "RECEIPT";

  // Release every allocation: decrement the doc's amountPaid and recompute status.
  const allocs = await tx
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.paymentId, payment.id));
  for (const a of allocs) {
    if (a.salesDocId) {
      const d = await tx.select().from(salesDocs).where(eq(salesDocs.id, a.salesDocId)).limit(1);
      const doc = d[0];
      if (!doc) continue;
      const paid = doc.amountPaid - a.amount;
      if (paid < 0n) throw new UserError(`Allocation on ${doc.docNo} exceeds its paid amount — data is inconsistent.`);
      await tx
        .update(salesDocs)
        .set({ amountPaid: paid, status: statusAfterPaid(paid, doc.grandTotal, doc.returnedTotal), updatedAt: new Date() })
        .where(eq(salesDocs.id, doc.id));
    } else if (a.purchaseDocId) {
      const d = await tx.select().from(purchaseDocs).where(eq(purchaseDocs.id, a.purchaseDocId)).limit(1);
      const doc = d[0];
      if (!doc) continue;
      const paid = doc.amountPaid - a.amount;
      if (paid < 0n) throw new UserError(`Allocation on ${doc.docNo} exceeds its paid amount — data is inconsistent.`);
      await tx
        .update(purchaseDocs)
        .set({ amountPaid: paid, status: statusAfterPaid(paid, doc.grandTotal, doc.returnedTotal), updatedAt: new Date() })
        .where(eq(purchaseDocs.id, doc.id));
    }
    await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, a.id));
  }

  // Reverse the original journal line-for-line (swap debits/credits).
  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, payment.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.");

  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: payment.branchId,
    date: voidDate,
    memo: `Void of ${payment.docNo ?? "payment"}${input.reason ? ` — ${input.reason}` : ""}`,
    reference: payment.reference ?? undefined,
    source: FIX3_SOURCES.PAYMENT_VOID,
    sourceId: payment.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
    })),
  });
  // Module 10: reverse any FX settlement gain/loss journals this payment
  // posted when it settled foreign-currency documents — the documents are
  // unpaid again, so the realized gain/loss never happened.
  const fxEntries = await tx
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(
      and(
        eq(journalEntries.companyId, input.companyId),
        eq(journalEntries.source, "FX_SETTLEMENT"),
        eq(journalEntries.sourceId, payment.id)
      )
    );
  for (const fx of fxEntries) {
    const fxLines = await tx
      .select()
      .from(journalLines)
      .where(eq(journalLines.entryId, fx.id));
    if (fxLines.length === 0) continue;
    await createJournal(tx, {
      companyId: input.companyId,
      branchId: payment.branchId,
      date: voidDate,
      memo: `Void of FX settlement on ${payment.docNo ?? "payment"}`,
      source: "FX_SETTLEMENT_VOID",
      sourceId: payment.id,
      createdById: input.userId,
      lines: fxLines.map((l) => ({
        accountId: l.accountId,
        debit: l.credit,
        credit: l.debit,
        partyId: l.partyId,
        memo: l.memo ?? undefined,
      })),
    });
  }
  // Restore balances: exact inverse of postPayment's bumps. postPayment
  // bumps the party by (isCustomer === isReceipt ? -amount : +amount), so
  // the void subtracts that same bump back off.
  const partyDelta = isCustomer === isReceipt ? -payment.amount : payment.amount;
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${partyDelta}`, updatedAt: new Date() })
    .where(eq(parties.id, payment.partyId!));
  // Module 7.2: cash moved net of withheld tax at posting time.
  const netCash = payment.amount - (payment.whtAmount ?? 0n);
  await tx
    .update(bankAccounts)
    // Module 7.2: postPayment moves cash NET of withheld tax, so the void
    // must restore the net amount — restoring the gross would overstate
    // the account by the withheld tax.
    .set({ balance: sql`${bankAccounts.balance} + ${isReceipt ? -netCash : netCash}` })
    .where(eq(bankAccounts.id, payment.bankAccountId));

  await tx.run(
    sql`UPDATE payments SET voided_at = ${voidDate.getTime()}, void_journal_entry_id = ${voidEntryId}, voided_by_id = ${input.userId} WHERE id = ${payment.id}`
  );

  // Module 7.2: the voided payment's WHT deduction never happened — mark its
  // register rows voided so they leave the WHT Deduction Register.
  await tx
    .update(whtDeductions)
    .set({ voidedAt: voidDate })
    .where(and(eq(whtDeductions.paymentId, payment.id), eq(whtDeductions.companyId, input.companyId)));

  return { voidJournalEntryId: voidEntryId };
}

export type UnallocateInput = {
  companyId: string;
  allocationId: string;
  userId: string;
};

/**
 * G4 — free one allocation row back to unallocated credit. The journal is
 * untouched (the money already moved); only the doc's amountPaid/status and
 * the allocation row change. Blocked when the payment is voided or either the
 * payment date or the doc date sits in a locked period.
 */
export async function unallocatePaymentRow(
  tx: DbTx,
  input: UnallocateInput
): Promise<{ paymentId: string; freedAmount: bigint }> {
  const ar = await tx
    .select()
    .from(paymentAllocations)
    .where(eq(paymentAllocations.id, input.allocationId))
    .limit(1);
  const alloc = ar[0];
  if (!alloc) throw new UserError("Allocation not found.");

  const pr = await tx
    .select()
    .from(payments)
    .where(and(eq(payments.id, alloc.paymentId), eq(payments.companyId, input.companyId)))
    .limit(1);
  const payment = pr[0];
  if (!payment) throw new UserError("Payment not found.");
  const voidedAt = (
    await tx.run(sql`SELECT voided_at AS v FROM payments WHERE id = ${payment.id}`)
  ).rows[0] as unknown as { v: number | null } | undefined;
  if (voidedAt?.v) throw new UserError("This payment is voided — its allocations cannot be changed.");

  await assertPeriodOpen(tx, input.companyId, payment.date);

  if (alloc.salesDocId) {
    const d = await tx.select().from(salesDocs).where(eq(salesDocs.id, alloc.salesDocId)).limit(1);
    const doc = d[0];
    if (!doc || doc.companyId !== input.companyId) throw new UserError("The allocated document is invalid.");
    await assertPeriodOpen(tx, input.companyId, doc.date);
    const paid = doc.amountPaid - alloc.amount;
    if (paid < 0n) throw new UserError("Allocation exceeds the document's paid amount.");
    await tx
      .update(salesDocs)
      .set({ amountPaid: paid, status: statusAfterPaid(paid, doc.grandTotal, doc.returnedTotal), updatedAt: new Date() })
      .where(eq(salesDocs.id, doc.id));
  } else if (alloc.purchaseDocId) {
    const d = await tx.select().from(purchaseDocs).where(eq(purchaseDocs.id, alloc.purchaseDocId)).limit(1);
    const doc = d[0];
    if (!doc || doc.companyId !== input.companyId) throw new UserError("The allocated document is invalid.");
    await assertPeriodOpen(tx, input.companyId, doc.date);
    const paid = doc.amountPaid - alloc.amount;
    if (paid < 0n) throw new UserError("Allocation exceeds the document's paid amount.");
    await tx
      .update(purchaseDocs)
      .set({ amountPaid: paid, status: statusAfterPaid(paid, doc.grandTotal, doc.returnedTotal), updatedAt: new Date() })
      .where(eq(purchaseDocs.id, doc.id));
  } else {
    throw new UserError("Allocation has no linked document.");
  }

  await tx.delete(paymentAllocations).where(eq(paymentAllocations.id, alloc.id));
  return { paymentId: payment.id, freedAmount: alloc.amount };
}

export type VoidExpenseInput = {
  companyId: string;
  expenseId: string;
  reason?: string;
  userId: string;
};

/**
 * G8 — void an expense. Posts the exact reversing journal (Dr bank /
 * Cr expense account, tax line included), restores the bank balance, and
 * stamps the expense as voided. Blocked in locked periods.
 */
export async function voidExpense(
  tx: DbTx,
  input: VoidExpenseInput
): Promise<{ voidJournalEntryId: string }> {
  const er = await tx
    .select()
    .from(expenses)
    .where(and(eq(expenses.id, input.expenseId), eq(expenses.companyId, input.companyId)))
    .limit(1);
  const expense = er[0];
  if (!expense) throw new UserError("Expense not found.");
  const voidedAt = (
    await tx.run(sql`SELECT voided_at AS v FROM expenses WHERE id = ${expense.id}`)
  ).rows[0] as unknown as { v: number | null } | undefined;
  if (voidedAt?.v) throw new UserError("This expense is already voided.");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, expense.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, expense.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.");

  const gl = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, expense.accountId)).limit(1);
  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: expense.branchId,
    date: voidDate,
    memo: `Void of expense — ${gl[0]?.name ?? "expense"}${input.reason ? ` — ${input.reason}` : ""}`,
    source: FIX3_SOURCES.EXPENSE_VOID,
    sourceId: expense.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
    })),
  });

  const total = expense.amount + expense.taxAmount;
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${total}` })
    .where(eq(bankAccounts.id, expense.bankAccountId));

  await tx.run(
    sql`UPDATE expenses SET voided_at = ${voidDate.getTime()}, void_journal_entry_id = ${voidEntryId}, voided_by_id = ${input.userId} WHERE id = ${expense.id}`
  );

  return { voidJournalEntryId: voidEntryId };
}

export type VoidSundryReceiptInput = {
  companyId: string;
  receiptId: string;
  reason?: string;
  userId: string;
};

/**
 * Module 3 — void a sundry receipt. Posts the exact reversing journal
 * (Dr credited account / Cr bank), restores the bank balance, and stamps the
 * receipt as voided. Blocked in locked periods.
 */
export async function voidSundryReceipt(
  tx: DbTx,
  input: VoidSundryReceiptInput
): Promise<{ voidJournalEntryId: string }> {
  const rr = await tx
    .select()
    .from(sundryReceipts)
    .where(and(eq(sundryReceipts.id, input.receiptId), eq(sundryReceipts.companyId, input.companyId)))
    .limit(1);
  const receipt = rr[0];
  if (!receipt) throw new UserError("Receipt not found.");
  const voidedAt = (
    await tx.run(sql`SELECT voided_at AS v FROM sundry_receipts WHERE id = ${receipt.id}`)
  ).rows[0] as unknown as { v: number | null } | undefined;
  if (voidedAt?.v) throw new UserError("This receipt is already voided.");

  const voidDate = new Date();
  await assertPeriodOpen(tx, input.companyId, receipt.date);
  await assertPeriodOpen(tx, input.companyId, voidDate);

  const origLines = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, receipt.journalEntryId!));
  if (origLines.length === 0) throw new UserError("The original journal entry is missing — cannot void safely.");

  const gl = await tx.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, receipt.accountId)).limit(1);
  const voidEntryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: receipt.branchId,
    date: voidDate,
    memo: `Void of receipt — ${gl[0]?.name ?? "receipt"}${input.reason ? ` — ${input.reason}` : ""}`,
    source: FIX3_SOURCES.SUNDRY_RECEIPT_VOID,
    sourceId: receipt.id,
    createdById: input.userId,
    lines: origLines.map((l) => ({
      accountId: l.accountId,
      debit: l.credit,
      credit: l.debit,
      partyId: l.partyId,
      memo: l.memo ?? undefined,
    })),
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${receipt.amount}` })
    .where(eq(bankAccounts.id, receipt.bankAccountId));

  await tx.run(
    sql`UPDATE sundry_receipts SET voided_at = ${voidDate.getTime()}, void_journal_entry_id = ${voidEntryId}, voided_by_id = ${input.userId} WHERE id = ${receipt.id}`
  );

  return { voidJournalEntryId: voidEntryId };
}
