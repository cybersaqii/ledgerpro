import { eq, and, sql, asc, inArray, lte } from "drizzle-orm";
import {
  bankAccounts,
  parties,
  payments,
  pdcCheques,
  purchaseDocs,
  salesDocs,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { createJournal, allocatePaymentToDoc } from "./posting";

// ─── Post-dated cheques ────────────────────────────────────────
// RECEIVED: a customer's PDC held by us. ISSUED: our PDC held by a supplier.
// Lifecycle: PENDING -> CLEARED | BOUNCED | CANCELLED.
//
// Journals (all balanced, all reversible):
//   record RECEIVED: Dr PDC Receivable (1310) / Cr AR (party)
//   record ISSUED:   Dr AP (party) / Cr PDC Payable (2110)
//   clear RECEIVED:  Dr Bank / Cr PDC Receivable (+ auto-allocate to oldest open invoices)
//   clear ISSUED:    Dr PDC Payable / Cr Bank (+ auto-allocate to oldest open bills)
//   bounce/cancel:   exact mirror of the record entry.
//
// Party-balance convention matches payments (Wave 1): recording a PDC moves
// the outstanding toward us on both sides, so balance -= amount at record and
// balance += amount on bounce/cancel. Clearing moves PDC -> bank and never
// touches the party balance (it already moved at record time).

export type PdcKind = "RECEIVED" | "ISSUED";

export type RecordPdcInput = {
  companyId: string;
  branchId: string;
  kind: PdcKind;
  partyId: string;
  chequeNo: string;
  bankName?: string;
  amount: bigint;
  chequeDate: Date;
  refNo?: string;
  notes?: string;
  createdById: string;
  /** Module 17: double-submit protection for the record POST. */
  idempotencyKey?: string;
};

async function partyKind(tx: DbTx, companyId: string, partyId: string): Promise<string> {
  const rows = await tx
    .select({ kind: parties.kind })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  const kind = rows[0]?.kind;
  if (!kind) throw new UserError("Party not found");
  return kind;
}

async function loadPdc(tx: DbTx, companyId: string, pdcId: string) {
  const rows = await tx
    .select()
    .from(pdcCheques)
    .where(and(eq(pdcCheques.id, pdcId), eq(pdcCheques.companyId, companyId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new UserError("Cheque not found");
  return row;
}

export async function recordPdc(tx: DbTx, input: RecordPdcInput): Promise<string> {
  if (input.amount <= 0n) throw new UserError("Cheque amount must be positive");
  if (!input.chequeNo.trim()) throw new UserError("Cheque number is required");
  const ac = await accountMap(tx, input.companyId);

  const kind = await partyKind(tx, input.companyId, input.partyId);
  if (input.kind === "RECEIVED" && kind !== "CUSTOMER")
    throw new UserError("A received cheque must belong to a customer");
  if (input.kind === "ISSUED" && kind !== "SUPPLIER")
    throw new UserError("An issued cheque must belong to a supplier");

  const isReceived = input.kind === "RECEIVED";
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.chequeDate,
    memo: `PDC ${isReceived ? "received" : "issued"} — Chq ${input.chequeNo.trim()}${input.bankName ? ` (${input.bankName})` : ""}`,
    reference: input.chequeNo.trim(),
    source: "PDC",
    createdById: input.createdById,
    lines: isReceived
      ? [
          { accountId: ac[SYS.PDC_RECEIVABLE], debit: input.amount, credit: 0n },
          { accountId: ac[SYS.AR], debit: 0n, credit: input.amount, partyId: input.partyId },
        ]
      : [
          { accountId: ac[SYS.AP], debit: input.amount, credit: 0n, partyId: input.partyId },
          { accountId: ac[SYS.PDC_PAYABLE], debit: 0n, credit: input.amount },
        ],
  });

  const pdcId = crypto.randomUUID();
  await tx.insert(pdcCheques).values({
    id: pdcId,
    companyId: input.companyId,
    branchId: input.branchId,
    kind: input.kind,
    partyId: input.partyId,
    chequeNo: input.chequeNo.trim(),
    bankName: input.bankName?.trim() || null,
    amount: input.amount,
    chequeDate: input.chequeDate,
    refNo: input.refNo?.trim() || null,
    status: "PENDING",
    journalEntryId: entryId,
    notes: input.notes?.trim() || null,
    createdById: input.createdById,
    // Module 17: idempotency key for the record POST (NULL = client sent none).
    idempotencyKey: input.idempotencyKey ?? null,
  });

  // Outstanding moves toward us on both sides at record time.
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, input.partyId));

  return pdcId;
}

/** Oldest open documents of the party's own side, for auto-allocation on clear. */
async function oldestOpenDocs(
  tx: DbTx,
  companyId: string,
  partyId: string,
  side: "SALES" | "PURCHASE"
): Promise<{ docId: string; remaining: bigint }[]> {
  if (side === "SALES") {
    const rows = await tx
      .select({ id: salesDocs.id, date: salesDocs.date, grandTotal: salesDocs.grandTotal, amountPaid: salesDocs.amountPaid, returnedTotal: salesDocs.returnedTotal })
      .from(salesDocs)
      .where(
        and(
          eq(salesDocs.companyId, companyId),
          eq(salesDocs.partyId, partyId),
          eq(salesDocs.docType, "INVOICE"),
          inArray(salesDocs.status, ["POSTED", "PARTIAL"])
        )
      )
      .orderBy(asc(salesDocs.date), asc(salesDocs.createdAt), asc(salesDocs.id));
    return rows
      .map((r) => ({ docId: r.id, remaining: r.grandTotal - r.amountPaid - r.returnedTotal }))
      .filter((r) => r.remaining > 0n);
  }
  const rows = await tx
    .select({ id: purchaseDocs.id, date: purchaseDocs.date, grandTotal: purchaseDocs.grandTotal, amountPaid: purchaseDocs.amountPaid, returnedTotal: purchaseDocs.returnedTotal })
    .from(purchaseDocs)
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.partyId, partyId),
        eq(purchaseDocs.docType, "BILL"),
        inArray(purchaseDocs.status, ["POSTED", "PARTIAL"])
      )
    )
    .orderBy(asc(purchaseDocs.date), asc(purchaseDocs.createdAt), asc(purchaseDocs.id));
  return rows
    .map((r) => ({ docId: r.id, remaining: r.grandTotal - r.amountPaid - r.returnedTotal }))
    .filter((r) => r.remaining > 0n);
}

export type ClearPdcInput = {
  pdcId: string;
  companyId: string;
  branchId: string;
  bankAccountId: string;
  date: Date;
  createdById: string;
  /** Module 17: double-submit protection — stored on the minted CHEQUE payment. */
  idempotencyKey?: string;
};

/** Clear a pending PDC: money hits the bank, and the amount is booked as a
 *  CHEQUE payment auto-allocated to the oldest open documents. Returns the
 *  created payment id. */
export async function clearPdc(tx: DbTx, input: ClearPdcInput): Promise<string> {
  const pdc = await loadPdc(tx, input.companyId, input.pdcId);
  if (pdc.status !== "PENDING") throw new UserError("Only pending cheques can be cleared");
  const ac = await accountMap(tx, input.companyId);

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new UserError("Bank/cash account not found");

  const isReceived = pdc.kind === "RECEIVED";
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `PDC cleared — Chq ${pdc.chequeNo}${pdc.bankName ? ` (${pdc.bankName})` : ""}`,
    reference: pdc.chequeNo,
    source: "PDC_CLEAR",
    sourceId: pdc.id,
    createdById: input.createdById,
    lines: isReceived
      ? [
          { accountId: bank.accountId, debit: pdc.amount, credit: 0n },
          { accountId: ac[SYS.PDC_RECEIVABLE], debit: 0n, credit: pdc.amount },
        ]
      : [
          { accountId: ac[SYS.PDC_PAYABLE], debit: pdc.amount, credit: 0n },
          { accountId: bank.accountId, debit: 0n, credit: pdc.amount },
        ],
  });

  // Book it as a real CHEQUE payment so it appears in Receipts/Payments and
  // the allocation breakdown works exactly like a normal payment.
  const paymentId = crypto.randomUUID();
  const paymentDocNo = await nextDocNo(tx, input.companyId, isReceived ? "RECEIPT" : "PAYMENT");
  await tx.insert(payments).values({
    id: paymentId,
    companyId: input.companyId,
    branchId: input.branchId,
    kind: isReceived ? "RECEIPT" : "PAYMENT",
    docNo: paymentDocNo, // REC- / PAY- so PDC-cleared payments show in doc lists like normal ones
    date: input.date,
    partyId: pdc.partyId,
    bankAccountId: bank.id,
    amount: pdc.amount,
    method: "CHEQUE",
    reference: pdc.chequeNo,
    notes: `PDC ${isReceived ? "received" : "issued"} cleared`,
    journalEntryId: entryId,
    createdById: input.createdById,
    // Module 17: the clear POST's idempotency key rides on the payment row.
    idempotencyKey: input.idempotencyKey ?? null,
  });

  let leftover = pdc.amount;
  const side = isReceived ? "SALES" : "PURCHASE";
  for (const d of await oldestOpenDocs(tx, input.companyId, pdc.partyId, side)) {
    if (leftover <= 0n) break;
    const take = d.remaining < leftover ? d.remaining : leftover;
    await allocatePaymentToDoc(tx, {
      companyId: input.companyId,
      paymentId,
      partyId: pdc.partyId,
      docKind: side,
      docId: d.docId,
      amount: take,
      // Module 10: FX gain/loss posts when the clear settles a
      // foreign-currency document (inside this same transaction).
      settleFx: { branchId: input.branchId, date: input.date, createdById: input.createdById },
    });
    leftover -= take;
  }

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${isReceived ? pdc.amount : -pdc.amount}` })
    .where(eq(bankAccounts.id, bank.id));

  await tx
    .update(pdcCheques)
    .set({ status: "CLEARED", bankAccountId: bank.id, clearedAt: input.date, updatedAt: new Date() })
    .where(eq(pdcCheques.id, pdc.id));

  return paymentId;
}

export type ReversePdcInput = {
  pdcId: string;
  companyId: string;
  branchId: string;
  date: Date;
  createdById: string;
  reason?: string;
  /** Module 17: optional bounce fee (paisa). RECEIVED → charged to the
   *  customer (Dr AR / Cr Bounce Charges income); ISSUED → charged to us
   *  by the supplier (Dr Bounce Charges expense / Cr AP). */
  bounceFee?: bigint;
};

/** Bounce or cancel a pending PDC: exact mirror of the record entry, party
 *  balance restored. Bounce may additionally carry a bounce fee. */
async function reversePdc(
  tx: DbTx,
  input: ReversePdcInput,
  toStatus: "BOUNCED" | "CANCELLED"
): Promise<void> {
  const pdc = await loadPdc(tx, input.companyId, input.pdcId);
  if (pdc.status !== "PENDING") throw new UserError(`Only pending cheques can be ${toStatus.toLowerCase()}`);
  const ac = await accountMap(tx, input.companyId);
  const fee = input.bounceFee ?? 0n;
  if (fee < 0n) throw new UserError("Bounce fee cannot be negative", 422, "NEGATIVE_BOUNCE_FEE");
  if (toStatus !== "BOUNCED" && fee > 0n)
    throw new UserError("A bounce fee can only be charged on a bounced cheque", 422, "FEE_ON_CANCEL");

  const isReceived = pdc.kind === "RECEIVED";
  await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `PDC ${toStatus.toLowerCase()} — Chq ${pdc.chequeNo}${input.reason ? ` (${input.reason})` : ""}`,
    reference: pdc.chequeNo,
    source: `PDC_${toStatus}`,
    sourceId: pdc.id,
    createdById: input.createdById,
    // Mirror of the record entry.
    lines: isReceived
      ? [
          { accountId: ac[SYS.AR], debit: pdc.amount, credit: 0n, partyId: pdc.partyId },
          { accountId: ac[SYS.PDC_RECEIVABLE], debit: 0n, credit: pdc.amount },
        ]
      : [
          { accountId: ac[SYS.PDC_PAYABLE], debit: pdc.amount, credit: 0n },
          { accountId: ac[SYS.AP], debit: 0n, credit: pdc.amount, partyId: pdc.partyId },
        ],
  });

  // Restore the outstanding the record had moved toward us.
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} + ${pdc.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, pdc.partyId));

  // Module 17: bounce fee — a separate balanced journal so the fee stays
  // visible on its own (and on the party's statement).
  if (fee > 0n) {
    await createJournal(tx, {
      companyId: input.companyId,
      branchId: input.branchId,
      date: input.date,
      memo: `Cheque bounce fee — Chq ${pdc.chequeNo}${input.reason ? ` (${input.reason})` : ""}`,
      reference: pdc.chequeNo,
      source: "PDC_BOUNCE_FEE",
      sourceId: pdc.id,
      createdById: input.createdById,
      lines: isReceived
        ? [
            // The customer bears the fee: their receivable grows.
            { accountId: ac[SYS.AR], debit: fee, credit: 0n, partyId: pdc.partyId },
            { accountId: ac[SYS.BOUNCE_INCOME], debit: 0n, credit: fee },
          ]
        : [
            // The supplier charges us the fee: our payable grows.
            { accountId: ac[SYS.BOUNCE_EXPENSE], debit: fee, credit: 0n },
            { accountId: ac[SYS.AP], debit: 0n, credit: fee, partyId: pdc.partyId },
          ],
    });
    // The fee moves the outstanding away from us on both sides.
    await tx
      .update(parties)
      .set({ balance: sql`${parties.balance} + ${fee}`, updatedAt: new Date() })
      .where(eq(parties.id, pdc.partyId));
  }

  await tx
    .update(pdcCheques)
    .set({ status: toStatus, clearedAt: input.date, updatedAt: new Date() })
    .where(eq(pdcCheques.id, pdc.id));
}

export async function bouncePdc(tx: DbTx, input: ReversePdcInput): Promise<void> {
  return reversePdc(tx, input, "BOUNCED");
}

export async function cancelPdc(tx: DbTx, input: ReversePdcInput): Promise<void> {
  return reversePdc(tx, input, "CANCELLED");
}

// ─── Due-for-clearing suggestions ──────────────────────────────
// A PDC becomes actionable on its cheque date: this is the "auto-suggest
// clearing" surface — pending cheques with chequeDate <= asOf, oldest first.

export type DuePdcRow = {
  id: string;
  kind: string;
  partyId: string;
  partyName: string | null;
  chequeNo: string;
  bankName: string | null;
  amount: bigint;
  chequeDate: Date;
};

export async function duePdcCheques(
  dbx: Db | DbTx,
  companyId: string,
  asOf: Date,
  kind?: PdcKind,
  limit = 50
): Promise<DuePdcRow[]> {
  const conds = [
    eq(pdcCheques.companyId, companyId),
    eq(pdcCheques.status, "PENDING"),
    lte(pdcCheques.chequeDate, asOf),
  ];
  if (kind) conds.push(eq(pdcCheques.kind, kind));
  const rows = await dbx
    .select({
      id: pdcCheques.id,
      kind: pdcCheques.kind,
      partyId: pdcCheques.partyId,
      partyName: parties.name,
      chequeNo: pdcCheques.chequeNo,
      bankName: pdcCheques.bankName,
      amount: pdcCheques.amount,
      chequeDate: pdcCheques.chequeDate,
    })
    .from(pdcCheques)
    .leftJoin(parties, eq(pdcCheques.partyId, parties.id))
    .where(and(...conds))
    .orderBy(asc(pdcCheques.chequeDate), asc(pdcCheques.createdAt))
    .limit(limit);
  return rows;
}
