/**
 * Phase 3 — draft documents (FA audit triage: save-as-draft, edit-from-detail).
 *
 * Model (deliberate, mirrors the approval-staging precedent in
 * lib/approvals.ts finalizeSalesInvoice / finalizePurchaseBill):
 * - A draft (DRAFT status) posts NOTHING: no journal, no stock, no receipt,
 *   no advance, no approval staging. The create routes save it that way
 *   when `saveAsDraft` is set (quotations/orders are drafts by design).
 * - A draft can be EDITED (PUT — this file recomputes totals from the
 *   submitted body with the same pipeline the create routes use) or POSTED
 *   (this file replays the stored rows through postSalesDoc /
 *   postPurchaseDoc, exactly like approving a staged invoice).
 * - Posting a draft does NOT replay a receipt or an advance — like an
 *   approved staged invoice, those are recorded afterwards on the posted
 *   document. Draft bills cannot carry landed extra costs (the paid-from
 *   choice and labels are not stored on the doc), so the create/edit routes
 *   reject extraCosts on drafts with a clear 422 instead of silently
 *   dropping them. Batch choices ARE stored on the item rows (migration
 *   0075) so a draft replays them exactly.
 * - POSTED documents cannot be edited here: editing a posted doc means
 *   reverse + repost, which needs a user decision (see docs/decision-log.md).
 *   Only DRAFT docs reach these functions; anything else is a 409.
 * - Edit is PKR-only: stored line rates are PKR, so a foreign-currency
 *   draft cannot be re-opened in the form without corrupting its rates.
 *   The PUT routes reject non-PKR drafts with FOREIGN_DRAFT_EDIT.
 */
import { eq, and, inArray } from "drizzle-orm";
import {
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
  parties,
  products,
} from "@/db/schema";
import type { Db, DbTx } from "@/lib/db";
import type { salesDocSchema, purchaseDocSchema } from "@/lib/validators";
import { computeTotals, type DocTotals } from "@/lib/totals";
import { qtyRateTotal } from "@/lib/money";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { resolveDocCurrency, type FxDocResult } from "@/lib/fx-docs";
import { minorToDecimalString, foreignToPaisa } from "@/lib/fx";
import { getCurrency } from "@/lib/fx-rates";
import { resolveLineUnits } from "@/lib/uom-lines";
import { applyDiscountMatrix } from "@/lib/pricing";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { activeParty, rebuildComputedItem } from "@/lib/approvals";
import { assertPeriodOpen } from "@/lib/period";
import { validateProjectId } from "@/lib/projects";
import { belowMinPrice, floorErrorMessage } from "@/lib/min-price";
import { enforceCreditLimit, newUdhaarForInvoice } from "@/lib/credit-limit";
import { evaluateCreditHold, assertCreditOk } from "@/lib/credit-control";
import { whtRateBps, whtAmountPaisa } from "@/lib/wht";
import { UserError } from "@/lib/errors";
import type z from "zod";

export type SalesDocBody = z.infer<typeof salesDocSchema>;
export type PurchaseDocBody = z.infer<typeof purchaseDocSchema>;

export type PostDraftOpts = {
  overrideCreditLimit?: boolean;
  overrideCreditHold?: boolean;
  priceOverride?: boolean;
};

/** Parse "YYYY-MM-DD" as UTC noon — same rule as lib/route-helpers
 *  parseDateOnly (duplicated here so lib code stays free of next/headers). */
function parseDateOnlyLocal(s: string): Date {
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime())) throw new UserError("Invalid date");
  return d;
}

function toDateOrNull(s: string | undefined | null): Date | null {
  if (!s) return null;
  return parseDateOnlyLocal(s);
}

// ─── Shared totals preparation (same pipeline as the create routes) ───

type PreparedTotals = {
  totals: DocTotals;
  fx: FxDocResult;
  unitSnap: { unit: string | null; unitQtyMilli: bigint | null; unitRatePkr: bigint | null }[];
  date: Date;
  dueDate: Date | null;
  expectedDeliveryDate: Date | null;
};

async function prepareTotals(
  dbx: Db | DbTx,
  companyId: string,
  body: SalesDocBody | PurchaseDocBody,
  partyCategory: string | null | undefined,
  isSales: boolean
): Promise<PreparedTotals> {
  const date = parseDateOnlyLocal(body.date);
  const dueDate = toDateOrNull(body.dueDate || null);
  const expectedDeliveryDate =
    body.docType === "ORDER" ? toDateOrNull(body.expectedDeliveryDate || null) : null;
  const curRow = await getCurrency(dbx, companyId, (body.currencyCode || "PKR").trim().toUpperCase());
  const minorUnits = curRow?.minorUnits ?? 2;
  const unitResolved = await resolveLineUnits(
    dbx,
    companyId,
    body.items.map((i) => ({
      productId: i.productId || null,
      qty: i.qty,
      rate: i.rate || "0",
      unit: i.unit || null,
    })),
    minorUnits
  );
  const fx = await resolveDocCurrency(dbx, companyId, {
    currencyCode: body.currencyCode,
    date,
    items: body.items.map((i, idx) => ({
      productId: i.productId || null,
      description: i.description,
      qtyMilli: parseQty(unitResolved[idx]!.qty),
      rate: unitResolved[idx]!.rate,
      discount: i.discount || "0",
      taxBps: i.taxBps,
    })),
    discountTotal: body.discountTotal || "0",
    freightTotal: (body as { freightTotal?: string }).freightTotal || "0",
  });
  const unitSnap = unitResolved.map((u) => {
    if (!u.unit || u.unitQtyMilli == null || u.unitRateMinor == null)
      return { unit: null, unitQtyMilli: null, unitRatePkr: null };
    // Same foreign → PKR conversion the create routes apply.
    const unitRatePkr =
      fx.rateScaled == null ? u.unitRateMinor : foreignToPaisa(u.unitRateMinor, fx.rateScaled, minorUnits);
    return { unit: u.unit, unitQtyMilli: u.unitQtyMilli, unitRatePkr };
  });
  let totals: DocTotals;
  if (isSales) {
    // Module 22: discount matrix — server-authoritative, same as create.
    const extras = await applyDiscountMatrix(
      dbx,
      companyId,
      partyCategory,
      fx.pkrItems.map((i) => ({
        productId: i.productId,
        grossPaisa: qtyRateTotal(i.qtyMilli, i.ratePaisa),
        discountPaisa: i.discountPaisa,
      }))
    );
    for (const e of extras) {
      if (e.extraPaisa > 0n) fx.pkrItems[e.index]!.discountPaisa += e.extraPaisa;
    }
    totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal, fx.pkrFreightTotal);
  } else {
    totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal);
  }
  return { totals, fx, unitSnap, date, dueDate, expectedDeliveryDate };
}

async function loadPartyForWrite(
  dbx: Db | DbTx,
  companyId: string,
  partyId: string,
  kind: "CUSTOMER" | "SUPPLIER"
) {
  const rows = await dbx
    .select()
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId), eq(parties.isActive, true)))
    .limit(1);
  const party = rows[0];
  if (!party || party.kind !== kind)
    throw new UserError(`Please select a valid ${kind === "CUSTOMER" ? "customer" : "supplier"}.`, 422);
  return party;
}

// ─── Edit a DRAFT (PUT) ───

export async function updateDraftSalesDoc(
  db: Db,
  companyId: string,
  docId: string,
  body: SalesDocBody
): Promise<{ docId: string; docNo: string }> {
  const [doc] = await db
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, docId), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Not found.", 404, "NOT_FOUND");
  if (doc.status !== "DRAFT")
    throw new UserError("Only draft documents can be edited. Posted documents cannot be changed.", 409, "DOC_LOCKED");
  if (doc.docType !== body.docType)
    throw new UserError("A document's type cannot be changed.", 422);
  if ((doc.currencyCode || "PKR").toUpperCase() !== "PKR" || (body.currencyCode || "PKR").toUpperCase() !== "PKR")
    throw new UserError("Foreign-currency drafts cannot be edited yet — post or delete this draft and create a new one.", 422, "FOREIGN_DRAFT_EDIT");
  if (body.receipt)
    throw new UserError("Drafts cannot carry a receipt — record it after posting.", 422);

  const party = await loadPartyForWrite(db, companyId, body.partyId, "CUSTOMER");
  const productIds = [...new Set(body.items.map((i) => i.productId).filter(Boolean) as string[])];
  if (productIds.length > 0) {
    const prodRows = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)));
    if (prodRows.length !== productIds.length)
      throw new UserError("One of the selected products is invalid.", 422);
  }
  const prep = await prepareTotals(db, companyId, body, party.category, true);
  await assertPeriodOpen(db, companyId, prep.date);
  const projectId = await validateProjectId(db, companyId, body.projectId);

  await db.transaction(async (tx) => {
    await tx.delete(salesDocItems).where(eq(salesDocItems.docId, docId));
    await tx.insert(salesDocItems).values(
      prep.totals.items.map((i, idx) => ({
        id: crypto.randomUUID(),
        docId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
        batchId: (body.items[idx]?.batchId || "").trim() || null,
        branchId: (body.items[idx]?.branchId || "").trim() || null,
        unit: prep.unitSnap[idx]?.unit ?? null,
        unitQty: prep.unitSnap[idx]?.unitQtyMilli ?? null,
        unitRate: prep.unitSnap[idx]?.unitRatePkr ?? null,
      }))
    );
    await tx
      .update(salesDocs)
      .set({
        partyId: party.id,
        date: prep.date,
        dueDate: prep.dueDate,
        expectedDeliveryDate: prep.expectedDeliveryDate,
        subtotal: prep.totals.subtotal,
        discountTotal: prep.fx.pkrDiscountTotal,
        freightTotal: prep.fx.pkrFreightTotal,
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        currencyCode: prep.fx.currencyCode,
        exchangeRateScaled: prep.fx.rateScaled,
        foreignSubtotal: prep.fx.foreignSubtotal,
        foreignTotal: prep.fx.foreignTotal,
        notes: body.notes || null,
        refNo: body.refNo || null,
        terms: body.terms || null,
        projectId,
        updatedAt: new Date(),
      })
      .where(eq(salesDocs.id, docId));
  });
  return { docId: doc.id, docNo: doc.docNo };
}

export async function updateDraftPurchaseDoc(
  db: Db,
  companyId: string,
  docId: string,
  body: PurchaseDocBody
): Promise<{ docId: string; docNo: string }> {
  const [doc] = await db
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, docId), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Not found.", 404, "NOT_FOUND");
  if (doc.status !== "DRAFT")
    throw new UserError("Only draft documents can be edited. Posted documents cannot be changed.", 409, "DOC_LOCKED");
  if (doc.docType !== body.docType)
    throw new UserError("A document's type cannot be changed.", 422);
  if (doc.docType === "GRN")
    throw new UserError("GRNs cannot be edited — receive a new GRN instead.", 422);
  if ((doc.currencyCode || "PKR").toUpperCase() !== "PKR" || (body.currencyCode || "PKR").toUpperCase() !== "PKR")
    throw new UserError("Foreign-currency drafts cannot be edited yet — post or delete this draft and create a new one.", 422, "FOREIGN_DRAFT_EDIT");
  if (body.receipt)
    throw new UserError("Drafts cannot carry a payment — record it after posting.", 422);
  if (body.docType === "BILL" && (body.extraCosts ?? []).some((c) => parseMoney(c.amount) > 0n))
    throw new UserError("Draft bills cannot carry landed extra costs — post the bill directly or remove them.", 422, "DRAFT_EXTRA_COSTS");

  const party = await loadPartyForWrite(db, companyId, body.partyId, "SUPPLIER");
  const productIds = [...new Set(body.items.map((i) => i.productId).filter(Boolean) as string[])];
  if (productIds.length > 0) {
    const prodRows = await db
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)));
    if (prodRows.length !== productIds.length)
      throw new UserError("One of the selected products is invalid.", 422);
  }
  const prep = await prepareTotals(db, companyId, body, party.category, false);
  await assertPeriodOpen(db, companyId, prep.date);
  const projectId = await validateProjectId(db, companyId, body.projectId);

  // Module 2.4: WHT — explicit rate when given, else the supplier's default.
  let whtBps = 0;
  let whtAmount = 0n;
  if (body.docType === "BILL") {
    whtBps =
      body.whtBps ??
      whtRateBps(party.whtCategory, {
        activeTaxPayer: !!party.activeTaxPayer,
        filerStatus: party.filerStatus,
      });
    if (!Number.isInteger(whtBps) || whtBps < 0 || whtBps > 10000)
      throw new UserError("WHT rate must be between 0 and 100%.", 422);
    // Net goods/services value excl. sales tax — same base the create route uses.
    const base = prep.totals.items.reduce((a, i) => a + i.taxablePaisa, 0n);
    whtAmount = whtAmountPaisa(base, whtBps);
  }

  await db.transaction(async (tx) => {
    await tx.delete(purchaseDocItems).where(eq(purchaseDocItems.docId, docId));
    await tx.insert(purchaseDocItems).values(
      prep.totals.items.map((i, idx) => ({
        id: crypto.randomUUID(),
        docId,
        productId: i.productId,
        description: i.description,
        qty: i.qtyMilli,
        rate: i.ratePaisa,
        discount: i.discountPaisa,
        taxBps: i.taxBps,
        taxAmount: i.taxAmountPaisa,
        lineTotal: i.lineTotalPaisa,
        extraCost: 0n,
        batchId: (body.items[idx]?.batchId || "").trim() || null,
        batchNo: (body.items[idx]?.batchNo || "").trim() || null,
        expiryDate: (body.items[idx]?.expiryDate || "").trim() || null,
        branchId: (body.items[idx]?.branchId || "").trim() || null,
        unit: prep.unitSnap[idx]?.unit ?? null,
        unitQty: prep.unitSnap[idx]?.unitQtyMilli ?? null,
        unitRate: prep.unitSnap[idx]?.unitRatePkr ?? null,
      }))
    );
    await tx
      .update(purchaseDocs)
      .set({
        partyId: party.id,
        date: prep.date,
        dueDate: prep.dueDate,
        expectedDeliveryDate: prep.expectedDeliveryDate,
        subtotal: prep.totals.subtotal,
        discountTotal: prep.fx.pkrDiscountTotal,
        taxTotal: prep.totals.taxTotal,
        grandTotal: prep.totals.grandTotal,
        currencyCode: prep.fx.currencyCode,
        exchangeRateScaled: prep.fx.rateScaled,
        foreignSubtotal: prep.fx.foreignSubtotal,
        foreignTotal: prep.fx.foreignTotal,
        whtBps: body.docType === "BILL" ? whtBps : 0,
        whtAmount: body.docType === "BILL" ? whtAmount : 0n,
        deductFromInventory: body.docType === "RETURN" ? body.deductFromInventory : true,
        notes: body.notes || null,
        refNo: body.refNo || null,
        terms: body.terms || null,
        projectId,
        updatedAt: new Date(),
      })
      .where(eq(purchaseDocs.id, docId));
  });
  return { docId: doc.id, docNo: doc.docNo };
}

// ─── Post a DRAFT (POST /api/sales|purchases/[id]/post) ───

export async function postDraftSalesDoc(
  tx: DbTx,
  companyId: string,
  docId: string,
  actorId: string,
  opts: PostDraftOpts = {}
): Promise<{ docId: string; docNo: string }> {
  const [doc] = await tx
    .select()
    .from(salesDocs)
    .where(and(eq(salesDocs.id, docId), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Not found.", 404, "NOT_FOUND");
  if (doc.status !== "DRAFT")
    throw new UserError("Only draft documents can be posted.", 409, "DOC_NOT_DRAFT");
  if (doc.docType !== "INVOICE" && doc.docType !== "RETURN")
    throw new UserError(`A ${doc.docType.toLowerCase()} cannot be posted — convert it instead.`, 409, "DOC_NOT_POSTABLE");
  if (doc.journalEntryId)
    throw new UserError("This document was already posted.", 409, "ALREADY_POSTED");

  const party = await activeParty(tx, companyId, doc.partyId, "CUSTOMER");
  await assertPeriodOpen(tx, companyId, doc.date);
  const itemRows = await tx.select().from(salesDocItems).where(eq(salesDocItems.docId, doc.id));
  if (itemRows.length === 0) throw new UserError("A draft with no lines cannot be posted.", 422);
  const productIds = [...new Set(itemRows.map((r) => r.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock, minSalePrice: products.minSalePrice })
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));

  // Minimum sale price lock — a draft skipped this check at creation, so it
  // runs here (same rule as creating a posted invoice).
  if (doc.docType === "INVOICE" && !opts.priceOverride) {
    const low = belowMinPrice(
      itemRows.map((r) => ({
        productId: r.productId,
        description: r.description,
        rate: minorToDecimalString(r.rate, 2),
      })),
      prodMap
    );
    if (low.length > 0) throw new UserError(floorErrorMessage(low), 422, "BELOW_MIN_PRICE");
  }

  const projectId = await validateProjectId(tx, companyId, doc.projectId);
  const entryId = await postSalesDoc(tx, {
    companyId,
    branchId: doc.branchId,
    partyId: party.id,
    docId: doc.id,
    docNo: doc.docNo,
    docType: doc.docType as "INVOICE" | "RETURN",
    date: doc.date,
    items: itemRows.map((r) => ({
      ...rebuildComputedItem(r),
      trackStock: r.productId ? (prodMap.get(r.productId)?.trackStock ?? false) : false,
      batchId: r.batchId ?? null,
      branchId: r.branchId,
    })),
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    freightTotal: doc.freightTotal ?? 0n,
    grandTotal: doc.grandTotal,
    createdById: actorId,
    projectId,
    sourceDocId: doc.sourceDocId ?? undefined,
    skipStock: !doc.stockPosted,
  });
  await tx
    .update(salesDocs)
    .set({ journalEntryId: entryId, status: "POSTED", updatedAt: new Date() })
    .where(eq(salesDocs.id, doc.id));

  // Udhaar control — same checks as creating a posted invoice (no receipt
  // or advance rides along with a posted draft, so the whole grand total
  // counts as new udhaar — the staged-invoice rule).
  if (doc.docType === "INVOICE") {
    if (!opts.overrideCreditHold) {
      const decision = await evaluateCreditHold(tx, { companyId, partyId: party.id, actor: actorId });
      assertCreditOk(
        {
          name: party.name,
          creditStatus: decision.held ? "HOLD" : "OK",
          creditHoldReason: decision.reason,
          creditHoldAt: decision.held ? new Date() : null,
        },
        {
          newCreditPaisa: newUdhaarForInvoice({
            grandTotalPaisa: doc.grandTotal,
            advanceAppliedPaisa: 0n,
            receiptAllocatedPaisa: 0n,
          }),
        }
      );
    }
    if (!opts.overrideCreditLimit) {
      await enforceCreditLimit(tx, {
        companyId,
        partyId: party.id,
        newCreditPaisa: newUdhaarForInvoice({
          grandTotalPaisa: doc.grandTotal,
          advanceAppliedPaisa: 0n,
          receiptAllocatedPaisa: 0n,
        }),
      });
    }
  }
  return { docId: doc.id, docNo: doc.docNo };
}

export async function postDraftPurchaseDoc(
  tx: DbTx,
  companyId: string,
  docId: string,
  actorId: string
): Promise<{ docId: string; docNo: string }> {
  const [doc] = await tx
    .select()
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, docId), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!doc) throw new UserError("Not found.", 404, "NOT_FOUND");
  if (doc.status !== "DRAFT")
    throw new UserError("Only draft documents can be posted.", 409, "DOC_NOT_DRAFT");
  if (doc.docType !== "BILL" && doc.docType !== "RETURN")
    throw new UserError(`A ${doc.docType.toLowerCase()} cannot be posted — convert it instead.`, 409, "DOC_NOT_POSTABLE");
  if (doc.journalEntryId)
    throw new UserError("This document was already posted.", 409, "ALREADY_POSTED");

  const party = await activeParty(tx, companyId, doc.partyId, "SUPPLIER");
  await assertPeriodOpen(tx, companyId, doc.date);
  const itemRows = await tx.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, doc.id));
  if (itemRows.length === 0) throw new UserError("A draft with no lines cannot be posted.", 422);
  if (itemRows.some((r) => (r.extraCost ?? 0n) > 0n))
    throw new UserError("This draft bill carries landed extra costs — edit it to remove them before posting.", 409, "DRAFT_EXTRA_COSTS");
  const productIds = [...new Set(itemRows.map((r) => r.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await tx
          .select({ id: products.id, trackStock: products.trackStock })
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const trackById = new Map(prodRows.map((p) => [p.id, !!p.trackStock]));

  const projectId = await validateProjectId(tx, companyId, doc.projectId);
  const entryId = await postPurchaseDoc(tx, {
    companyId,
    branchId: doc.branchId,
    partyId: party.id,
    docId: doc.id,
    docNo: doc.docNo,
    docType: doc.docType as "BILL" | "RETURN",
    date: doc.date,
    items: itemRows.map((r) => ({
      ...rebuildComputedItem(r),
      trackStock: r.productId ? (trackById.get(r.productId) ?? false) : false,
      batchNo: r.batchNo ?? null,
      expiryDate: r.expiryDate ?? null,
      batchId: r.batchId ?? null,
      branchId: r.branchId,
    })),
    discountTotal: doc.discountTotal,
    taxTotal: doc.taxTotal,
    grandTotal: doc.grandTotal,
    createdById: actorId,
    extraCosts: [],
    whtAmount: doc.whtAmount ?? undefined,
    whtBps: doc.whtBps ?? undefined,
    deductFromInventory: doc.deductFromInventory,
    projectId,
  });
  await tx
    .update(purchaseDocs)
    .set({ journalEntryId: entryId, status: "POSTED", updatedAt: new Date() })
    .where(eq(purchaseDocs.id, doc.id));
  return { docId: doc.id, docNo: doc.docNo };
}
