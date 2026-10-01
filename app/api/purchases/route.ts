import { NextRequest } from "next/server";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { purchaseDocs, purchaseDocItems, parties, products, productBatches, branches } from "@/db/schema";
import { purchaseDocSchema } from "@/lib/validators";
import { computeTotals } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { resolveDocCurrency, type FxDocResult } from "@/lib/fx-docs";
import { foreignToPaisa } from "@/lib/fx";
import { getCurrency } from "@/lib/fx-rates";
import { resolveLineUnits } from "@/lib/uom-lines";
import { postPurchaseDoc, distributeExtraCost, postPayment } from "@/lib/posting";
import { validateProjectId } from "@/lib/projects";
import { approvalRequired, stageApprovalRequest, findApprovalRequestByIdemKey } from "@/lib/approvals";
import { clientIp } from "@/lib/rate-limit-db";
import { createGrn } from "@/lib/grn";
import { applySupplierAdvance } from "@/lib/supplier-advance";
import { whtRateBps, whtAmountPaisa, whtSectionForCategory } from "@/lib/wht";
import { periodLockError } from "@/lib/period";
import { nextDocNo } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { userHasPermission } from "@/lib/permissions";
import type { Permission } from "@/lib/permissions";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

const POSTED_TYPES = ["BILL", "RETURN"] as const;

/** Purchase orders are governed by the documents permission; bills/returns by purchases. */
function permForDocType(docType: string | null): Permission {
  return docType === "PURCHASE_ORDER" ? "documents" : "purchases";
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const docType = sp.get("docType");
  const gate = await requirePermission(permForDocType(docType));
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const partyId = sp.get("partyId");
  const q = sp.get("q")?.trim() ?? "";
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(purchaseDocs.companyId, companyId)];
  if (docType) conds.push(eq(purchaseDocs.docType, docType));
  if (partyId) conds.push(eq(purchaseDocs.partyId, partyId));
  if (q) conds.push(sql`${purchaseDocs.docNo} LIKE ${`%${q}%`}`);
  if (from) {
    try { conds.push(sql`${purchaseDocs.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${purchaseDocs.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ doc: purchaseDocs, partyName: parties.name })
    .from(purchaseDocs)
    .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(desc(purchaseDocs.date), desc(purchaseDocs.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseDocs)
    .where(and(...conds));
  const sums = await db
    .select({ s: sql<string | null>`sum(${purchaseDocs.grandTotal})` })
    .from(purchaseDocs)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.doc, partyName: r.partyName })),
    total: total[0]?.n ?? 0,
    sumGrandTotal: sums[0]?.s ?? "0",
    page,
    perPage,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = purchaseDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const gate = await requirePermission(permForDocType(parsed.data.docType));
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const b = parsed.data;

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created doc with 200 instead of double-posting.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, purchaseDocs, companyId, idemKey);
    if (existing)
      return json(
        { data: { docId: existing.id, docNo: existing.docNo, idempotentReplay: true } },
        { status: 200 }
      );
    const staged = await findApprovalRequestByIdemKey(db, companyId, idemKey);
    if (staged)
      return json(
        {
          data: {
            approvalId: staged.id,
            docNo: staged.docNo,
            status: staged.status,
            idempotentReplay: true,
          },
        },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "purchases", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  // A payment moves money, so paying with the bill needs the payments
  // permission on top of the purchases permission.
  if (b.receipt && b.docType === "BILL") {
    const canPay = await userHasPermission(db, session.uid, "payments");
    if (!canPay) return err("You don't have permission to record payments.", 403);
  }

  const partyRows = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId), eq(parties.isActive, true)))
    .limit(1);
  const party = partyRows[0];
  if (!party || party.kind !== "SUPPLIER") return err("Please select a valid supplier.", 422);

  // Module 2.4: the vendor's bill reference is compulsory on purchase bills.
  if (b.docType === "BILL" && !(b.refNo || "").trim())
    return err("The vendor's bill reference is required.", 422, "VENDOR_REF_REQUIRED");

  // Module 2.3: GRNs post through the dedicated GRN engine (inventory in,
  // GRNI accrual out, order linkage) rather than the bill pipeline below.
  if (b.docType === "GRN") {
    if (!b.orderId) return err("Select the purchase order this receipt is for.", 422);
    const lines = (b.grnLines ?? []).map((l) => ({
      sourceItemId: l.sourceItemId,
      receivedQty: parseQty(l.receivedQty),
      damagedQty: parseQty(l.damagedQty),
    }));
    let grnDate: Date;
    try {
      grnDate = parseDateOnly(b.date);
    } catch (e) {
      return toApiError(e, { route: "/api/purchases", companyId });
    }
    const grnLockErr = await periodLockError(db, companyId, grnDate);
    if (grnLockErr) return err(grnLockErr, 422, "PERIOD_LOCKED");
    const grnBranchId = b.branchId || (await defaultBranchId(db, companyId));
    try {
      const grn = await db.transaction(async (tx) => {
        await assertBranch(tx, companyId, grnBranchId);
        return createGrn(tx, {
          companyId,
          orderId: b.orderId!,
          partyId: b.partyId,
          branchId: grnBranchId,
          date: grnDate,
          notes: b.notes || undefined,
          lines,
          userId: session.uid,
          idempotencyKey: idemKey,
        });
      });
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "purchase.grn.created",
        entity: "purchase", entityId: grn.docId,
        detail: `GRN ${grn.docNo} received against order ${grn.orderDocNo}`,
      });
      return json({ data: { docId: grn.docId, docNo: grn.docNo } }, { status: 201 });
    } catch (e) {
      if (idemKey && isIdempotencyConflict(e)) {
        const existing = await findByIdempotencyKey(db, purchaseDocs, companyId, idemKey);
        if (existing)
          return json(
            { data: { docId: existing.id, docNo: existing.docNo, idempotentReplay: true } },
            { status: 200 }
          );
      }
      return toApiError(e, { route: "/api/purchases", companyId });
    }
  }

  const productIds = [...new Set(b.items.map((i) => i.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await db
          .select()
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  for (const pid of productIds) {
    if (!prodMap.has(pid)) return err("One of the selected products is invalid.", 422);
  }

  // Regex-passing but impossible dates ("2026-13-99") must answer 422, not 500.
  // Parsed before currency resolution: the day's exchange rate depends on it.
  let date: Date;
  let dueDate: Date | null;
  try {
    date = parseDateOnly(b.date);
    dueDate = b.dueDate ? parseDateOnly(b.dueDate) : null;
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }

  // Module 10: multi-currency — line rates/discounts arrive in the document's
  // currency; the server converts to PKR at the day's rate (single source of
  // truth — client previews are display-only).
  // Module 18: resolve per-line units to base units FIRST (qty AND rate),
  // so every downstream step (FX, totals, posting) stays in base units.
  let fx: FxDocResult;
  let unitSnap: { unit: string | null; unitQtyMilli: bigint | null; unitRatePkr: bigint | null }[];
  try {
    const curRow = await getCurrency(db, companyId, (b.currencyCode || "PKR").trim().toUpperCase());
    const minorUnits = curRow?.minorUnits ?? 2;
    const unitResolved = await resolveLineUnits(
      db,
      companyId,
      b.items.map((i) => ({
        productId: i.productId || null,
        qty: i.qty,
        rate: i.rate || "0",
        unit: i.unit || null,
      })),
      minorUnits
    );
    fx = await resolveDocCurrency(db, companyId, {
      currencyCode: b.currencyCode,
      date,
      items: b.items.map((i, idx) => ({
        productId: i.productId || null,
        description: i.description,
        qtyMilli: parseQty(unitResolved[idx]!.qty),
        rate: unitResolved[idx]!.rate,
        discount: i.discount || "0",
        taxBps: i.taxBps,
      })),
      discountTotal: b.discountTotal || "0",
    });
    // Chosen-unit snapshot for the line-item rows (PKR paisa, like rate).
    unitSnap = unitResolved.map((u) => {
      if (!u.unit || u.unitQtyMilli == null || u.unitRateMinor == null)
        return { unit: null, unitQtyMilli: null, unitRatePkr: null };
      const unitRatePkr =
        fx.rateScaled == null ? u.unitRateMinor : foreignToPaisa(u.unitRateMinor, fx.rateScaled, minorUnits);
      return { unit: u.unit, unitQtyMilli: u.unitQtyMilli, unitRatePkr };
    });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }

  let totals;
  try {
    totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal);
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }

  const isPosted = (POSTED_TYPES as readonly string[]).includes(b.docType);

  // Return lines may choose a batch to deduct from: it must belong to this
  // company and to the line's product. Bill lines carry batch_no/expiry_date
  // instead (validated strictly at posting time).

  // Module 2.4: WHT deducted on purchase bills — explicit rate when given,
  // otherwise the supplier's WHT-category default.
  let whtBps = 0;
  let whtAmount = 0n;
  if (b.docType === "BILL") {
    whtBps = b.whtBps ?? whtRateBps(party.whtCategory, {
      activeTaxPayer: !!party.activeTaxPayer,
      filerStatus: party.filerStatus,
    });
    if (!Number.isInteger(whtBps) || whtBps < 0 || whtBps > 10000)
      return err("WHT rate must be between 0 and 100%.", 422);
    whtAmount = whtAmountPaisa(
      totals.items.reduce((a, i) => a + i.taxablePaisa, 0n),
      whtBps
    );
  }
  if (isPosted && b.docType === "RETURN") {
    const wanted = b.items
      .map((i) => ({ batchId: (i.batchId || "").trim(), productId: i.productId || "" }))
      .filter((x) => x.batchId && x.productId);
    if (wanted.length > 0) {
      const ids = [...new Set(wanted.map((x) => x.batchId))];
      const rows = await db
        .select({ id: productBatches.id, productId: productBatches.productId })
        .from(productBatches)
        .where(and(eq(productBatches.companyId, companyId), inArray(productBatches.id, ids)));
      const ownerOf = new Map(rows.map((r) => [r.id, r.productId]));
      for (const w of wanted) {
        if (ownerOf.get(w.batchId) !== w.productId)
          return err("The selected batch is not valid for this product.", 422);
      }
    }
  }

  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  // Landed extra costs: distribute over stock-tracked lines (same math as posting)
  const extraCosts = (b.extraCosts ?? [])
    .map((c) => ({ label: c.label, amount: parseMoney(c.amount) }))
    .filter((c) => c.amount > 0n);
  const totalExtra = extraCosts.reduce((a, c) => a + c.amount, 0n);

  // Module 6.3: an active approval rule stages over-threshold bills instead
  // of posting them — no journal, stock, payment or advance moves until an
  // approver approves the staged request. Same-transaction payments are
  // rejected; supplier-advance auto-apply is skipped for staged bills (the
  // approver can allocate the advance manually after approval).
  const needsApproval =
    b.docType === "BILL" &&
    (await approvalRequired(db, companyId, "PURCHASE_BILL", totals.grandTotal));
  if (needsApproval && b.receipt)
    return err(
      "This bill exceeds the approval threshold, so it is staged for approval — record the payment after it is approved.",
      422,
      "APPROVAL_NO_RECEIPT"
    );

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      // Module 4.2: per-line location overrides must be branches of this company.
      const lineBranches = [...new Set(b.items.map((i) => (i.branchId || "").trim()).filter(Boolean))];
      if (lineBranches.length > 0) {
        const rows = await tx
          .select({ id: branches.id })
          .from(branches)
          .where(and(eq(branches.companyId, companyId), inArray(branches.id, lineBranches)));
        if (rows.length !== lineBranches.length)
          throw new UserError("A selected line location is invalid.", 422);
      }
      const docNo = await nextDocNo(tx, companyId, b.docType === "RETURN" ? "PURCHASE_RETURN" : b.docType);
      const docId = crypto.randomUUID();

      const stockNets: { idx: number; net: bigint }[] = [];
      totals.items.forEach((it, idx) => {
        const track = it.productId ? prodMap.get(it.productId)?.trackStock ?? false : false;
        if (track) stockNets.push({ idx, net: it.taxablePaisa });
      });
      const landed = new Array<bigint>(totals.items.length).fill(0n);
      if (totalExtra > 0n) {
        const dist = distributeExtraCost(stockNets.map((s) => s.net), totalExtra);
        stockNets.forEach((s, j) => { landed[s.idx] = dist[j] ?? 0n; });
      }

      // Module 13: validate the project tag before anything is written.
      const projectId = await validateProjectId(tx, companyId, b.projectId);
      await tx.insert(purchaseDocs).values({
        id: docId,
        companyId,
        branchId,
        partyId: party.id,
        docType: b.docType,
        docNo,
        refNo: b.refNo || null,
        date,
        dueDate,
        projectId,
        status: needsApproval ? "PENDING_APPROVAL" : isPosted ? "POSTED" : "DRAFT",
        subtotal: totals.subtotal,
        discountTotal: fx.pkrDiscountTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        // Module 10: document currency (PKR docs store NULLs here).
        currencyCode: fx.currencyCode,
        exchangeRateScaled: fx.rateScaled,
        foreignSubtotal: fx.foreignSubtotal,
        foreignTotal: fx.foreignTotal,
        // Module 2.4 (WHT) / Module 2.6 (deduct-from-inventory on returns)
        whtBps: b.docType === "BILL" ? whtBps : 0,
        whtAmount: b.docType === "BILL" ? whtAmount : 0n,
        deductFromInventory: b.docType === "RETURN" ? b.deductFromInventory : true,
        notes: b.notes || null,
        terms: b.terms || null,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
      await tx.insert(purchaseDocItems).values(
        totals.items.map((i, idx) => ({
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
          extraCost: landed[idx] ?? 0n,
          // Module 4.2: per-line location override (NULL = doc branch).
          branchId: (b.items[idx]?.branchId || "").trim() || null,
          // Module 18: chosen-unit snapshot (NULL = base unit was used).
          unit: unitSnap[idx]?.unit ?? null,
          unitQty: unitSnap[idx]?.unitQtyMilli ?? null,
          unitRate: unitSnap[idx]?.unitRatePkr ?? null,
        }))
      );

      let entryId: string | null = null;
      let paymentDocNo: string | null = null;
      let advanceApplied = 0n;
      // Module 6.3: staged bills stop here. The payload carries the landed
      // extra-cost inputs (per-line distribution is already on the item rows)
      // so approval can replay posting exactly. Nothing financial moves yet.
      if (needsApproval) {
        const approvalId = await stageApprovalRequest(tx, {
          companyId,
          docType: "PURCHASE_BILL",
          docId,
          docNo,
          partyId: party.id,
          partyName: party.name,
          amountPaisa: totals.grandTotal,
          payload: {
            extraCosts: extraCosts.map((c) => ({ label: c.label, amountPaisa: c.amount.toString() })),
            extraCostPaidFrom: b.extraCostPaidFrom,
            extraCostAccountId: b.extraCostAccountId || undefined,
            lineBatches: b.items.map((i) => ({
              batchNo: (i.batchNo || "").trim() || null,
              expiryDate: (i.expiryDate || "").trim() || null,
            })),
          },
          requestedById: session.uid,
          requestedByName: session.name,
          idempotencyKey: idemKey,
        });
        return { docId, docNo, entryId, paymentDocNo, advanceApplied, approvalId };
      }
      if (isPosted) {
        entryId = await postPurchaseDoc(tx, {
          companyId,
          branchId,
          partyId: party.id,
          docId,
          docNo,
          docType: b.docType as "BILL" | "RETURN",
          date,
          items: totals.items.map((i, idx) => ({
            ...i,
            trackStock: i.productId ? prodMap.get(i.productId)?.trackStock ?? false : false,
            batchNo: (b.items[idx]?.batchNo || "").trim() || null,
            expiryDate: (b.items[idx]?.expiryDate || "").trim() || null,
            batchId: (b.items[idx]?.batchId || "").trim() || null,
            // Module 4.2: per-line location override (NULL = doc branch).
            branchId: (b.items[idx]?.branchId || "").trim() || null,
          })),
          discountTotal: fx.pkrDiscountTotal,
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
          createdById: session.uid,
          extraCosts,
          extraCostPaidFrom: b.extraCostPaidFrom,
          extraCostAccountId: b.extraCostAccountId || undefined,
          // Module 2.4 (bill WHT) / Module 2.6 (return deduct-from-inventory)
          whtAmount: b.docType === "BILL" ? whtAmount : undefined,
          // Module 7.2: register section + rate for the WHT Deduction Register.
          whtBps: b.docType === "BILL" ? whtBps : undefined,
          whtSection:
            b.docType === "BILL" && whtAmount > 0n ? whtSectionForCategory(party.whtCategory) : undefined,
          projectId,
          deductFromInventory: b.docType === "RETURN" ? b.deductFromInventory : undefined,
        });
        await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
        // Add Payment: posted in the same transaction, allocated to this bill.
        let alreadyPaid = 0n;
        if (b.docType === "BILL" && b.receipt) {
          const r = b.receipt;
          const rDate = parseDateOnly(r.date);
          const rLock = await periodLockError(tx, companyId, rDate);
          if (rLock) throw new Error(rLock);
          const rAmount = parseMoney(r.amount);
          if (rAmount <= 0n) throw new Error("Payment amount must be positive.");
          const remaining = totals.grandTotal;
          if (remaining <= 0n) throw new Error("Bill is already fully settled; no payment needed.");
          // Overpayment stays unallocated on the payment → becomes supplier credit.
          const alloc = rAmount > remaining ? remaining : rAmount;
          const rp = await postPayment(tx, {
            companyId,
            branchId,
            kind: "PAYMENT",
            partyId: party.id,
            bankAccountId: r.bankAccountId,
            date: rDate,
            amount: rAmount,
            method: r.method || "CASH",
            reference: r.reference || undefined,
            notes: `Payment against ${docNo}`,
            allocations: [{ docId, docKind: "PURCHASE", amount: alloc }],
            createdById: session.uid,
            // Module 13: the bill's project tag rides on the bundled payment
            // too (P&L-neutral — tagged payments are for traceability).
            projectId,
          });
          paymentDocNo = rp.docNo;
          alreadyPaid = alloc;
        }
        // Module 2.5: auto-consume the supplier's unallocated advance against
        // the new bill (after any same-transaction payment), mirroring the
        // sales-side advance behaviour.
        if (b.docType === "BILL" && b.applyAdvance !== false) {
          advanceApplied = await applySupplierAdvance(tx, {
            companyId,
            branchId,
            partyId: party.id,
            docId,
            docNo,
            grandTotal: totals.grandTotal,
            alreadyPaid,
            date,
            userId: session.uid,
          });
        }
      }
      return { docId, docNo, entryId, paymentDocNo, advanceApplied, approvalId: null as string | null };
    });
    // Module 6.3: staged for approval — nothing posted yet.
    if (result.approvalId) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "approval.requested",
        entity: "approval", entityId: result.approvalId,
        detail: `Bill ${result.docNo} staged for approval (Rs ${(totals.grandTotal / 100n).toLocaleString()})`,
        ip: clientIp(req),
        newValues: { status: "PENDING_APPROVAL", grandTotalPaisa: totals.grandTotal.toString() },
      });
      return json(
        {
          data: {
            docId: result.docId,
            docNo: result.docNo,
            approvalId: result.approvalId,
            status: "PENDING_APPROVAL",
          },
        },
        { status: 202 }
      );
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `purchase.${b.docType.toLowerCase()}.created`,
      entity: "purchase", entityId: result.docId,
      detail: `${b.docType} ${result.docNo}${totalExtra > 0n ? ` (+ extra costs Rs ${(totalExtra / 100n).toLocaleString()})` : ""}`,
    });
    if (result.paymentDocNo) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "purchase.payment.created",
        entity: "purchase", entityId: result.docId,
        detail: `Payment ${result.paymentDocNo} recorded with ${result.docNo}`,
      });
    }
    return json({ data: result }, { status: 201 });
  } catch (e) {
    // Lost the idempotency race: a concurrent request already created the
    // doc for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, purchaseDocs, companyId, idemKey);
      if (existing)
        return json(
          { data: { docId: existing.id, docNo: existing.docNo, idempotentReplay: true } },
          { status: 200 }
        );
      const staged = await findApprovalRequestByIdemKey(db, companyId, idemKey);
      if (staged)
        return json(
          {
            data: {
              approvalId: staged.id,
              docNo: staged.docNo,
              status: staged.status,
              idempotentReplay: true,
            },
          },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/purchases", companyId });
  }
}
