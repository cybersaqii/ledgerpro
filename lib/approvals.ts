// Module 6.3 — Multi-tier approval workflows.
//
// When a company's approval rule for a doc type is active and the document
// amount exceeds the threshold, creation is STAGED instead of posted:
//
//   SALES_INVOICE / PURCHASE_BILL:
//     the doc row is written with status PENDING_APPROVAL but NO journal
//     entry, NO stock movement, NO allocations, NO advances and NO
//     same-transaction receipt/payment. Approval replays the exact posting
//     path (postSalesDoc / postPurchaseDoc) inside one transaction.
//   PAYMENT / JOURNAL:
//     nothing is written at all — the validated create input is staged as a
//     JSON payload on the approval request and postPayment / postManualJournal
//     run at approval time, again inside one transaction.
//
// Either way the GL never sees a half-posting: rows appear only when the
// request flips to APPROVED in the same transaction that posts them.
// Segregation of duties: the requester can never approve their own request.
import { eq, and } from "drizzle-orm";
import {
  approvalRules,
  approvalRequests,
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  parties,
  products,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { parseMoney, qtyRateTotal } from "./money";
import { postSalesDoc } from "./posting";
import { postPurchaseDoc, type ExtraCostInput } from "./posting";
import { postPayment, type PostPaymentInput } from "./posting";
import { postManualJournal } from "./journal-vouchers";
import { validateProjectId } from "./projects";
import { assertPeriodOpen } from "./period";
import { enforceCreditLimit, newUdhaarForInvoice } from "./credit-limit";
import { fifoAllocations } from "./auto-allocate";
import type { ComputedItem } from "./totals";

/** Doc types an approval rule can govern. Stable strings — stored in the DB. */
export const APPROVAL_DOC_TYPES = [
  "SALES_INVOICE",
  "PURCHASE_BILL",
  "PAYMENT",
  "JOURNAL",
] as const;
export type ApprovalDocType = (typeof APPROVAL_DOC_TYPES)[number];

export function isApprovalDocType(v: string): v is ApprovalDocType {
  return (APPROVAL_DOC_TYPES as readonly string[]).includes(v);
}

export type ApprovalRule = {
  id: string;
  docType: ApprovalDocType;
  thresholdPaisa: bigint;
  isActive: boolean;
};

export async function getApprovalRules(
  tx: Db | DbTx,
  companyId: string
): Promise<ApprovalRule[]> {
  const rows = await tx
    .select()
    .from(approvalRules)
    .where(eq(approvalRules.companyId, companyId));
  return rows.map((r) => ({
    id: r.id,
    docType: r.docType as ApprovalDocType,
    thresholdPaisa: r.thresholdPaisa ?? 0n,
    isActive: !!r.isActive,
  }));
}

/** True when an active rule exists for docType and amount exceeds its threshold. */
export async function approvalRequired(
  tx: Db | DbTx,
  companyId: string,
  docType: ApprovalDocType,
  amountPaisa: bigint
): Promise<boolean> {
  const rows = await tx
    .select({ thresholdPaisa: approvalRules.thresholdPaisa, isActive: approvalRules.isActive })
    .from(approvalRules)
    .where(
      and(
        eq(approvalRules.companyId, companyId),
        eq(approvalRules.docType, docType),
        eq(approvalRules.isActive, true)
      )
    )
    .limit(1);
  const rule = rows[0];
  if (!rule) return false;
  return amountPaisa > (rule.thresholdPaisa ?? 0n);
}

// ─── Staging ─────────────────────────────────────────────────────────

export type StagedInvoicePayload = {
  // per-line batch choice captured at request time (salesDocItems doesn't
  // store batchId; postSalesDoc needs it for FIFO deduction).
  lineBatches: (string | null)[];
};

export type StagedBillPayload = {
  extraCosts: { label: string; amountPaisa: string }[];
  extraCostPaidFrom?: "CASH" | "SUPPLIER";
  extraCostAccountId?: string;
  // per-line batch_no/expiry for new tracked receipts (not on the item rows).
  lineBatches: { batchNo: string | null; expiryDate: string | null }[];
};

export type StagedPaymentPayload = {
  kind: "RECEIPT" | "PAYMENT";
  partyId: string;
  branchId: string;
  dateISO: string;
  bankAccountId: string;
  amountPaisa: string;
  method: string;
  reference?: string;
  notes?: string;
  allocations: { docId: string; docKind: "SALES" | "PURCHASE"; amountPaisa: string }[];
  autoAllocate: boolean;
  /** Module 7.2: WHT deducted at payment/receipt time (replayed on approve). */
  whtSection?: string;
  whtBps?: number;
  /** Module 13: project tag (validated at staging; replayed on approve). */
  projectId?: string;
};

export type StagedJournalPayload = {
  branchId: string;
  dateISO: string;
  memo: string;
  /** Module 13: project tag (validated at staging; replayed on approve). */
  projectId?: string;
  lines: {
    accountId: string;
    debitPaisa: string;
    creditPaisa: string;
    partyId?: string;
    memo?: string;
  }[];
};

function toJson(v: unknown): string {
  return JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));
}

/** Insert the approval request row inside the caller's transaction. */
export async function stageApprovalRequest(
  tx: DbTx,
  input: {
    companyId: string;
    docType: ApprovalDocType;
    docId?: string;
    docNo?: string;
    partyId?: string;
    partyName?: string;
    amountPaisa: bigint;
    payload: unknown;
    requestedById: string;
    requestedByName: string;
    idempotencyKey?: string;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date();
  await tx.insert(approvalRequests).values({
    id,
    companyId: input.companyId,
    docType: input.docType,
    status: "PENDING",
    docId: input.docId ?? null,
    docNo: input.docNo ?? null,
    partyId: input.partyId ?? null,
    partyName: input.partyName ?? null,
    amountPaisa: input.amountPaisa,
    payload: toJson(input.payload ?? {}),
    requestedById: input.requestedById,
    requestedByName: input.requestedByName,
    requestedAt: now,
    idempotencyKey: input.idempotencyKey ?? null,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function findApprovalRequest(
  tx: Db | DbTx,
  companyId: string,
  requestId: string
) {
  const rows = await tx
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.id, requestId), eq(approvalRequests.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function findApprovalRequestByIdemKey(
  tx: Db | DbTx,
  companyId: string,
  key: string
) {
  const rows = await tx
    .select({ id: approvalRequests.id, docNo: approvalRequests.docNo, status: approvalRequests.status })
    .from(approvalRequests)
    .where(and(eq(approvalRequests.companyId, companyId), eq(approvalRequests.idempotencyKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

// ─── Finalize: replay the normal posting path on approval ────────────

async function activeParty(
  tx: DbTx,
  companyId: string,
  partyId: string,
  kind: "CUSTOMER" | "SUPPLIER"
) {
  const rows = await tx
    .select()
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p || !p.isActive) throw new UserError("The party is no longer active.", 422, "PARTY_INACTIVE");
  if (p.kind !== kind)
    throw new UserError(`Expected a ${kind === "CUSTOMER" ? "customer" : "supplier"}.`, 422);
  return p;
}

function rebuildComputedItem(row: {
  productId: string | null;
  description: string;
  qty: bigint;
  rate: bigint;
  discount: bigint;
  taxBps: number;
  taxAmount: bigint;
  lineTotal: bigint;
}): ComputedItem {
  // qty is stored in milli-units; gross = qty × rate needs the /1000 that
  // qtyRateTotal applies (the same function computeTotals uses at staging).
  const grossPaisa = qtyRateTotal(row.qty, row.rate);
  return {
    productId: row.productId,
    description: row.description,
    qtyMilli: row.qty,
    ratePaisa: row.rate,
    discountPaisa: row.discount,
    taxBps: row.taxBps,
    grossPaisa,
    taxablePaisa: grossPaisa - row.discount,
    taxAmountPaisa: row.taxAmount,
    lineTotalPaisa: row.lineTotal,
  };
}

async function finalizeSalesInvoice(
  tx: DbTx,
  companyId: string,
  req: { docId: string | null; payload: string },
  approverId: string
): Promise<{ docId: string; docNo: string }> {
  if (!req.docId) throw new UserError("Approval request is missing its staged invoice.", 500);
  const [doc] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, req.docId), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Staged invoice not found.", 404);
  if (doc.status !== "PENDING_APPROVAL")
    throw new UserError("This invoice is no longer awaiting approval.", 409, "NOT_PENDING");
  if (doc.journalEntryId)
    throw new UserError("This invoice was already posted.", 409, "ALREADY_POSTED");

  const party = await activeParty(tx, companyId, doc.partyId, "CUSTOMER");
  await assertPeriodOpen(tx, companyId, doc.date);

  const itemRows = await tx
    .select()
    .from(salesDocItems)
    .where(eq(salesDocItems.docId, doc.id));
  const payload = JSON.parse(req.payload || "{}") as StagedInvoicePayload;

  const productIds = [...new Set(itemRows.map((r) => r.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(eq(products.companyId, companyId))
      : [];
  const trackById = new Map(prodRows.map((p) => [p.id, !!p.trackStock]));

  // Module 13: re-validate the tag — the project may have been cancelled
  // after the invoice was staged.
  const projectId = await validateProjectId(tx, companyId, doc.projectId);
  const entryId = await postSalesDoc(tx, {
    companyId,
    branchId: doc.branchId,
    partyId: party.id,
    docId: doc.id,
    docNo: doc.docNo,
    docType: "INVOICE",
    date: doc.date,
    items: itemRows.map((r, idx) => ({
      ...rebuildComputedItem(r),
      trackStock: r.productId ? (trackById.get(r.productId) ?? false) : false,
      batchId: payload.lineBatches?.[idx] ?? null,
      branchId: r.branchId,
    })),
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    freightTotal: doc.freightTotal ?? 0n,
    grandTotal: doc.grandTotal,
    createdById: approverId,
    // Module 13: project tag rides on the doc row into the replay.
    projectId,
  });
  await tx
    .update(salesDocs)
    .set({ journalEntryId: entryId, status: "POSTED", updatedAt: new Date() })
    .where(eq(salesDocs.id, doc.id));

  // Credit-limit check runs at approval time on the freshest balances —
  // no receipt/advance rides along with a staged invoice, so the whole
  // grand total counts as new udhaar.
  await enforceCreditLimit(tx, {
    companyId,
    partyId: party.id,
    newCreditPaisa: newUdhaarForInvoice({
      grandTotalPaisa: doc.grandTotal,
      advanceAppliedPaisa: 0n,
      receiptAllocatedPaisa: 0n,
    }),
  });
  return { docId: doc.id, docNo: doc.docNo };
}

async function finalizePurchaseBill(
  tx: DbTx,
  companyId: string,
  req: { docId: string | null; payload: string },
  approverId: string
): Promise<{ docId: string; docNo: string }> {
  if (!req.docId) throw new UserError("Approval request is missing its staged bill.", 500);
  const [doc] = await tx
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, req.docId), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Staged bill not found.", 404);
  if (doc.status !== "PENDING_APPROVAL")
    throw new UserError("This bill is no longer awaiting approval.", 409, "NOT_PENDING");
  if (doc.journalEntryId)
    throw new UserError("This bill was already posted.", 409, "ALREADY_POSTED");

  const party = await activeParty(tx, companyId, doc.partyId, "SUPPLIER");
  await assertPeriodOpen(tx, companyId, doc.date);

  const itemRows = await tx
    .select()
    .from(purchaseDocItems)
    .where(eq(purchaseDocItems.docId, doc.id));
  const payload = JSON.parse(req.payload || "{}") as StagedBillPayload;

  const productIds = [...new Set(itemRows.map((r) => r.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(eq(products.companyId, companyId))
      : [];
  const trackById = new Map(prodRows.map((p) => [p.id, !!p.trackStock]));

  const extraCosts: ExtraCostInput[] = (payload.extraCosts ?? []).map((c) => ({
    label: c.label,
    amount: parseMoney(c.amountPaisa),
  }));

  // Module 13: re-validate the tag — the project may have been cancelled
  // after the bill was staged.
  const projectId2 = await validateProjectId(tx, companyId, doc.projectId);
  const entryId = await postPurchaseDoc(tx, {
    companyId,
    branchId: doc.branchId,
    partyId: party.id,
    docId: doc.id,
    docNo: doc.docNo,
    docType: "BILL",
    date: doc.date,
    items: itemRows.map((r, idx) => ({
      ...rebuildComputedItem(r),
      trackStock: r.productId ? (trackById.get(r.productId) ?? false) : false,
      batchNo: payload.lineBatches?.[idx]?.batchNo ?? null,
      expiryDate: payload.lineBatches?.[idx]?.expiryDate ?? null,
      batchId: null,
      branchId: r.branchId,
    })),
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    grandTotal: doc.grandTotal,
    createdById: approverId,
    extraCosts,
    extraCostPaidFrom: payload.extraCostPaidFrom,
    extraCostAccountId: payload.extraCostAccountId,
    whtAmount: doc.whtAmount ?? undefined,
    // Module 7: replay the staged bill's WHT rate so the register row carries
    // it (the section is derived from the supplier's WHT category downstream).
    whtBps: doc.whtBps ?? undefined,
    // Module 13: project tag rides on the doc row into the replay.
    projectId: projectId2,
  });
  await tx
    .update(purchaseDocs)
    .set({ journalEntryId: entryId, status: "POSTED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, doc.id));
  return { docId: doc.id, docNo: doc.docNo };
}

async function finalizePayment(
  tx: DbTx,
  companyId: string,
  payload: StagedPaymentPayload,
  approverId: string
): Promise<{ id: string; docNo: string }> {
  const date = new Date(payload.dateISO);
  await assertPeriodOpen(tx, companyId, date);
  // Payload amounts are paisa strings (see StagedPaymentPayload) — BigInt, NOT
  // parseMoney, which would treat them as rupees and post 100× the amount.
  const totalPaisa = BigInt(payload.amountPaisa);
  const allocations: PostPaymentInput["allocations"] =
    payload.autoAllocate && payload.allocations.length === 0
      ? await fifoAllocations(tx, {
          companyId,
          partyId: payload.partyId,
          kind: payload.kind,
          amount: totalPaisa,
        })
      : payload.allocations.map((a) => ({
          docId: a.docId,
          docKind: a.docKind,
          amount: BigInt(a.amountPaisa),
        }));
  return postPayment(tx, {
    companyId,
    branchId: payload.branchId,
    kind: payload.kind,
    partyId: payload.partyId,
    bankAccountId: payload.bankAccountId,
    date,
    amount: totalPaisa,
    method: payload.method,
    reference: payload.reference || undefined,
    notes: payload.notes || undefined,
    allocations,
    createdById: approverId,
    // Module 7.2: replay the staged WHT deduction on approve.
    wht: payload.whtSection ? { section: payload.whtSection, rateBps: payload.whtBps ?? 0 } : undefined,
    // Module 13: project tag replayed from the staged payload.
    projectId: payload.projectId,
  });
}

async function finalizeJournal(
  tx: DbTx,
  companyId: string,
  payload: StagedJournalPayload,
  approverId: string
): Promise<{ id: string; docNo: string }> {
  // Lines are already paisa strings — BigInt, never parseMoney (×100 trap).
  const { entryId, docNo } = await postManualJournal(tx, {
    companyId,
    branchId: payload.branchId,
    date: new Date(payload.dateISO),
    memo: payload.memo,
    lines: payload.lines.map((l) => ({
      accountId: l.accountId,
      debit: BigInt(l.debitPaisa),
      credit: BigInt(l.creditPaisa),
      partyId: l.partyId || undefined,
      memo: l.memo || undefined,
    })),
    createdById: approverId,
    // Module 13: project tag replayed from the staged payload.
    projectId: payload.projectId,
  });
  return { id: entryId, docNo };
}

// ─── Decisions ───────────────────────────────────────────────────────

/**
 * Approve a pending request and post it — atomically. The request flips to
 * APPROVED in the same transaction that posts the journal, so a crash can
 * never leave a posted-but-unapproved (or approved-but-unposted) document.
 * Replays are safe: a non-PENDING request returns its current state.
 */
export async function approveRequest(
  tx: DbTx,
  args: {
    companyId: string;
    requestId: string;
    deciderId: string;
    deciderName: string;
    comment?: string;
  }
): Promise<{ requestId: string; status: string; docId: string | null; docNo: string | null }> {
  const req = await findApprovalRequest(tx, args.companyId, args.requestId);
  if (!req) throw new UserError("Approval request not found.", 404);
  if (req.status !== "PENDING")
    return {
      requestId: req.id,
      status: req.status,
      docId: req.docId,
      docNo: req.docNo,
    };
  // Segregation of duties: nobody approves their own request.
  if (req.requestedById === args.deciderId)
    throw new UserError(
      "You cannot approve your own request — ask another approver.",
      403,
      "SELF_APPROVAL"
    );

  let posted: { docId: string; docNo: string } | { id: string; docNo: string };
  switch (req.docType as ApprovalDocType) {
    case "SALES_INVOICE":
      posted = await finalizeSalesInvoice(tx, args.companyId, req, args.deciderId);
      break;
    case "PURCHASE_BILL":
      posted = await finalizePurchaseBill(tx, args.companyId, req, args.deciderId);
      break;
    case "PAYMENT":
      posted = await finalizePayment(
        tx,
        args.companyId,
        JSON.parse(req.payload || "{}") as StagedPaymentPayload,
        args.deciderId
      );
      break;
    case "JOURNAL":
      posted = await finalizeJournal(
        tx,
        args.companyId,
        JSON.parse(req.payload || "{}") as StagedJournalPayload,
        args.deciderId
      );
      break;
    default:
      throw new UserError(`Unknown approval doc type "${req.docType}".`, 500);
  }

  const now = new Date();
  const docId = "docId" in posted ? posted.docId : posted.id;
  await tx
    .update(approvalRequests)
    .set({
      status: "APPROVED",
      docId,
      docNo: posted.docNo,
      decidedById: args.deciderId,
      decidedByName: args.deciderName,
      decidedAt: now,
      decisionComment: args.comment?.trim() || null,
      updatedAt: now,
    })
    .where(eq(approvalRequests.id, req.id));
  return { requestId: req.id, status: "APPROVED", docId, docNo: posted.docNo };
}

export async function rejectRequest(
  tx: DbTx,
  args: {
    companyId: string;
    requestId: string;
    deciderId: string;
    deciderName: string;
    comment: string;
  }
): Promise<{ requestId: string; status: string }> {
  const req = await findApprovalRequest(tx, args.companyId, args.requestId);
  if (!req) throw new UserError("Approval request not found.", 404);
  if (req.status !== "PENDING") return { requestId: req.id, status: req.status };
  if (req.requestedById === args.deciderId)
    throw new UserError(
      "You cannot reject your own request — cancel it instead.",
      403,
      "SELF_APPROVAL"
    );
  if (!args.comment.trim())
    throw new UserError("A rejection comment is required.", 422, "COMMENT_REQUIRED");

  const now = new Date();
  await tx
    .update(approvalRequests)
    .set({
      status: "REJECTED",
      decidedById: args.deciderId,
      decidedByName: args.deciderName,
      decidedAt: now,
      decisionComment: args.comment.trim(),
      updatedAt: now,
    })
    .where(eq(approvalRequests.id, req.id));
  // The staged invoice/bill row goes back to a visible rejected state —
  // its journal was never posted, so nothing needs reversing.
  if (req.docId && (req.docType === "SALES_INVOICE" || req.docType === "PURCHASE_BILL")) {
    const table = req.docType === "SALES_INVOICE" ? salesDocs : purchaseDocs;
    await tx
      .update(table)
      .set({ status: "REJECTED", updatedAt: now })
      .where(eq(table.id, req.docId));
  }
  return { requestId: req.id, status: "REJECTED" };
}

/**
 * The requester (or the owner) withdraws a pending request. A staged
 * invoice/bill row returns to DRAFT so it can be corrected and resubmitted.
 */
export async function cancelRequest(
  tx: DbTx,
  args: { companyId: string; requestId: string; userId: string; isOwner: boolean }
): Promise<{ requestId: string; status: string }> {
  const req = await findApprovalRequest(tx, args.companyId, args.requestId);
  if (!req) throw new UserError("Approval request not found.", 404);
  if (req.status !== "PENDING") return { requestId: req.id, status: req.status };
  if (req.requestedById !== args.userId && !args.isOwner)
    throw new UserError("Only the requester or the owner can cancel this request.", 403);

  const now = new Date();
  await tx
    .update(approvalRequests)
    .set({ status: "CANCELLED", decidedById: args.userId, decidedAt: now, updatedAt: now })
    .where(eq(approvalRequests.id, req.id));
  if (req.docId && (req.docType === "SALES_INVOICE" || req.docType === "PURCHASE_BILL")) {
    const table = req.docType === "SALES_INVOICE" ? salesDocs : purchaseDocs;
    await tx
      .update(table)
      .set({ status: "DRAFT", updatedAt: now })
      .where(eq(table.id, req.docId));
  }
  return { requestId: req.id, status: "CANCELLED" };
}
