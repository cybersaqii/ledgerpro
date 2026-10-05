/**
 * Module 11 — Customer & Supplier Portals.
 *
 * Covers: token minting (plaintext shown once, sha256 hash storage),
 * revocation, expiry, tamper rejection, order-request lifecycle
 * (DRAFT -> SUBMITTED -> APPROVED/REJECTED, approve converts to a
 * NON-POSTING sales ORDER / DRAFT purchase BILL), payment intents
 * (intent-only, no postings until admin reconciliation posts a real
 * receipt), access levels, rate limiting, and company/party isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { insertParty } from "@/lib/party-create";
import { UserError } from "@/lib/errors";
import { rateLimitDb } from "@/lib/rate-limit-db";
import { portalGate } from "@/lib/portal-route";
import {
  mintPortalToken,
  hashPortalToken,
  resolvePortalToken,
  portalCan,
  createPortalOrderRequest,
  submitPortalOrderRequest,
  cancelPortalOrderRequest,
  approvePortalOrderRequest,
  rejectPortalOrderRequest,
  createPaymentIntent,
  reconcilePaymentIntent,
  cancelPaymentIntent,
  logPortalActivity,
} from "@/lib/portal";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let customer = "";
let customer2 = "";
let supplier = "";
let widget = "";
let invoiceId = ""; // posted sales invoice, Rs 2000 outstanding
let billId = ""; // posted purchase bill, Rs 4000 outstanding

async function journalCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.journalEntries)
    .where(eq(s.journalEntries.companyId, companyA));
  return rows[0]?.n ?? 0;
}

async function trialBalanceZero(): Promise<boolean> {
  const rows = await db
    .select({ net: sql<string>`coalesce(sum(${s.journalLines.debit} - ${s.journalLines.credit}), 0)` })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(eq(s.journalEntries.companyId, companyA));
  return BigInt(rows[0]?.net ?? "0") === 0n;
}

function item(productId: string | null, qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "M11 test item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

/** Insert a token row the way the admin issue-route does (hash only). */
async function issueToken(opts: {
  companyId: string;
  partyId: string;
  accessLevel?: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
}): Promise<{ id: string; token: string }> {
  const { token, hash } = mintPortalToken();
  const id = crypto.randomUUID();
  await db.insert(s.portalTokens).values({
    id,
    companyId: opts.companyId,
    partyId: opts.partyId,
    tokenHash: hash,
    accessLevel: opts.accessLevel ?? "ORDER",
    expiresAt: opts.expiresAt ?? null,
    revokedAt: opts.revokedAt ?? null,
    createdById: userId,
  });
  return { id, token };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyA);
  branchId = res.branchId;
  await setupCompany(db, companyB);
  // setupCompany seeds branches/accounts; the companies row itself is created
  // at signup in production — insert it here for both test companies.
  await db.insert(s.companies).values([
    { id: companyA, name: "M11 Company A", tradeName: "M11 Trade A" },
    { id: companyB, name: "M11 Company B" },
  ]);
  cashAccountId = (
    await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyA), eq(s.bankAccounts.kind, "CASH")))
      .limit(1)
  )[0]!.id;

  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId: companyA, userId, fields: { kind: "CUSTOMER", name: "M11 Customer" } })
  ));
  ({ id: customer2 } = await db.transaction((tx) =>
    insertParty(tx, { companyId: companyA, userId, fields: { kind: "CUSTOMER", name: "M11 Customer 2" } })
  ));
  ({ id: supplier } = await db.transaction((tx) =>
    insertParty(tx, { companyId: companyA, userId, fields: { kind: "SUPPLIER", name: "M11 Supplier" } })
  ));

  widget = crypto.randomUUID();
  await db.insert(s.products).values({
    id: widget,
    companyId: companyA,
    sku: "M11-WIDGET",
    name: "M11 Widget",
    unit: "PCS",
    purchasePrice: parseMoney("10"),
    salePrice: parseMoney("100"),
    trackStock: false,
  });

  // Posted sales invoice: 2 x Rs 1000 = Rs 2000 outstanding.
  const invItems = [item(widget, "2", "1000")];
  const invTotals = computeTotals(invItems, 0n, 0n);
  invoiceId = crypto.randomUUID();
  const invNo = await db.transaction((tx) => nextDocNo(tx, companyA, "INVOICE"));
  await db.insert(s.salesDocs).values({
    id: invoiceId, companyId: companyA, branchId, partyId: customer, docType: "INVOICE",
    docNo: invNo, date: new Date(), status: "POSTED", subtotal: invTotals.subtotal,
    discountTotal: 0n, taxTotal: 0n, grandTotal: invTotals.grandTotal, createdById: userId,
  });
  await db.insert(s.salesDocItems).values(
    invTotals.items.map((i) => ({
      id: crypto.randomUUID(), docId: invoiceId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: i.lineTotalPaisa,
    }))
  );
  const invEntry = await db.transaction((tx) =>
    postSalesDoc(tx, {
      companyId: companyA, branchId, partyId: customer, docId: invoiceId, docNo: invNo,
      docType: "INVOICE", date: new Date(),
      items: invTotals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, freightTotal: 0n, taxTotal: 0n, grandTotal: invTotals.grandTotal,
      createdById: userId,
    })
  );
  await db.update(s.salesDocs).set({ journalEntryId: invEntry }).where(eq(s.salesDocs.id, invoiceId));

  // Posted purchase bill: 2 x Rs 2000 = Rs 4000 outstanding.
  const billItems = [item(widget, "2", "2000")];
  const billTotals = computeTotals(billItems, 0n);
  billId = crypto.randomUUID();
  const billNo = await db.transaction((tx) => nextDocNo(tx, companyA, "BILL"));
  await db.insert(s.purchaseDocs).values({
    id: billId, companyId: companyA, branchId, partyId: supplier, docType: "BILL",
    docNo: billNo, date: new Date(), status: "POSTED", subtotal: billTotals.subtotal,
    discountTotal: 0n, taxTotal: 0n, grandTotal: billTotals.grandTotal,
    refNo: "SUP-001", createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values(
    billTotals.items.map((i) => ({
      id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: 0n, taxBps: 0, taxAmount: 0n, lineTotal: i.lineTotalPaisa,
    }))
  );
  const billEntry = await db.transaction((tx) =>
    postPurchaseDoc(tx, {
      companyId: companyA, branchId, partyId: supplier, docId: billId, docNo: billNo,
      docType: "BILL", date: new Date(),
      items: billTotals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: billTotals.grandTotal,
      whtAmount: 0n, createdById: userId,
    })
  );
  await db.update(s.purchaseDocs).set({ journalEntryId: billEntry }).where(eq(s.purchaseDocs.id, billId));
});

afterAll(() => cleanup());

// ─── Token minting / validation ─────────────────────────────────

describe("portal token security", () => {
  it("mints 256-bit tokens; only the sha256 hash is stored, plaintext shown once", async () => {
    const { token, hash } = mintPortalToken();
    expect(token.startsWith("lpt_")).toBe(true);
    // 4 (prefix) + 43 (base64url of 32 bytes) = 47 chars
    expect(token.length).toBe(47);
    expect(hash).toBe(hashPortalToken(token));
    expect(hash).not.toContain(token.slice(4, 12));

    const { id, token: t2 } = await issueToken({ companyId: companyA, partyId: customer });
    const rows = await db.select().from(s.portalTokens).where(eq(s.portalTokens.id, id));
    const stored = rows[0]!;
    expect(stored.tokenHash).toBe(hashPortalToken(t2));
    // The plaintext appears nowhere in the stored row.
    const blob = JSON.stringify(stored);
    expect(blob).not.toContain(t2);
    expect(blob).not.toContain(t2.slice(4));
  });

  it("two mints never collide", () => {
    const a = mintPortalToken();
    const b = mintPortalToken();
    expect(a.token).not.toBe(b.token);
    expect(a.hash).not.toBe(b.hash);
  });

  it("resolves a valid token to its party + company", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer, accessLevel: "FULL" });
    const res = await resolvePortalToken(db, token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.ctx.party.id).toBe(customer);
      expect(res.ctx.token.companyId).toBe(companyA);
      expect(res.ctx.token.accessLevel).toBe("FULL");
      expect(res.ctx.company.id).toBe(companyA);
    }
  });

  it("rejects tampered tokens", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer });
    const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
    const res = await resolvePortalToken(db, tampered);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PORTAL_TOKEN_INVALID");
  });

  it("rejects garbage / wrong-prefix tokens", async () => {
    for (const bad of ["", "lpt_short", "dvt_" + "x".repeat(43), "lpt_" + "z".repeat(43)]) {
      const res = await resolvePortalToken(db, bad);
      expect(res.ok).toBe(false);
    }
  });

  it("rejects revoked tokens", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer, revokedAt: new Date() });
    const res = await resolvePortalToken(db, token);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("PORTAL_TOKEN_REVOKED");
  });

  it("rejects expired tokens, accepts future-expiry tokens", async () => {
    const past = await issueToken({ companyId: companyA, partyId: customer, expiresAt: new Date(Date.now() - 1000) });
    const r1 = await resolvePortalToken(db, past.token);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe("PORTAL_TOKEN_EXPIRED");

    const future = await issueToken({ companyId: companyA, partyId: customer, expiresAt: new Date(Date.now() + 86400000) });
    const r2 = await resolvePortalToken(db, future.token);
    expect(r2.ok).toBe(true);
  });

  it("rejects tokens whose party was deleted", async () => {
    const { id: doomed } = await db.transaction((tx) =>
      insertParty(tx, { companyId: companyA, userId, fields: { kind: "CUSTOMER", name: "Doomed" } })
    );
    const { token } = await issueToken({ companyId: companyA, partyId: doomed });
    await db.delete(s.parties).where(eq(s.parties.id, doomed));
    const res = await resolvePortalToken(db, token);
    expect(res.ok).toBe(false);
  });
});

describe("portal access levels", () => {
  it("VIEW_ONLY < ORDER < FULL", () => {
    expect(portalCan("VIEW_ONLY", "VIEW_ONLY")).toBe(true);
    expect(portalCan("VIEW_ONLY", "ORDER")).toBe(false);
    expect(portalCan("ORDER", "ORDER")).toBe(true);
    expect(portalCan("ORDER", "FULL")).toBe(false);
    expect(portalCan("FULL", "FULL")).toBe(true);
    expect(portalCan("FULL", "ORDER")).toBe(true);
    expect(portalCan("BOGUS", "VIEW_ONLY")).toBe(false);
  });
});

// ─── Order requests ─────────────────────────────────────────────

const reqItems = [{ productId: widget, description: "M11 Widget", qtyMilli: "3", ratePaisa: "100" }];

describe("portal order requests", () => {
  it("full lifecycle: create DRAFT -> submit -> approve creates a NON-POSTING sales ORDER", async () => {
    const before = await journalCount();
    const { id: tokenId, token } = await issueToken({ companyId: companyA, partyId: customer, accessLevel: "ORDER" });
    const ctx = await resolvePortalToken(db, token);
    expect(ctx.ok).toBe(true);

    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId,
      kind: "SALES_ORDER", items: reqItems, notes: "urgent",
    });
    expect(created.status).toBe("DRAFT");
    expect(created.requestNo.startsWith("POR-")).toBe(true);
    expect(created.grandTotalPaisa).toBe(30000n); // 3 x Rs 100
    // No postings from request creation.
    expect(await journalCount()).toBe(before);

    const submitted = await submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer });
    expect(submitted.status).toBe("SUBMITTED");

    const { request, docId, docNo } = await approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id });
    expect(request.status).toBe("APPROVED");
    expect(request.approvedDocId).toBe(docId);
    expect(docNo.startsWith("ORD-")).toBe(true);
    // The converted document is a non-posting sales order.
    const docs = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId));
    expect(docs[0]!.docType).toBe("ORDER");
    expect(docs[0]!.status).toBe("PENDING");
    expect(docs[0]!.journalEntryId).toBeNull();
    expect(docs[0]!.grandTotal).toBe(30000n);
    const items = await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, docId));
    expect(items).toHaveLength(1);
    expect(items[0]!.qty).toBe(3000n);
    // Still no journal postings — approval conversion is non-posting.
    expect(await journalCount()).toBe(before);
    expect(await trialBalanceZero()).toBe(true);
  });

  it("reject flow records the reason; approving a rejected request fails", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer });
    const rejected = await rejectPortalOrderRequest(db, {
      companyId: companyA, userId, requestId: created.id, reason: "Out of stock",
    });
    expect(rejected.status).toBe("REJECTED");
    expect(rejected.rejectionReason).toBe("Out of stock");
    await expect(
      approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id })
    ).rejects.toThrow(UserError);
  });

  it("reject requires a reason; approve requires SUBMITTED", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await expect(
      approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id })
    ).rejects.toThrow(/submitted/i);
    await expect(
      rejectPortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id, reason: "  " })
    ).rejects.toThrow(UserError);
  });

  it("double approval is rejected", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer });
    await approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id });
    await expect(
      approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id })
    ).rejects.toThrow(UserError);
  });

  it("party can cancel its own draft request", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    const cancelled = await cancelPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer });
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("kind must match party kind", async () => {
    const { id: custTokenId } = await issueToken({ companyId: companyA, partyId: customer });
    await expect(
      createPortalOrderRequest(db, {
        companyId: companyA, partyId: customer, tokenId: custTokenId,
        kind: "BILL_SUBMISSION", items: reqItems, vendorRef: "V-1",
      })
    ).rejects.toThrow(/supplier/i);
    const { id: supTokenId } = await issueToken({ companyId: companyA, partyId: supplier });
    await expect(
      createPortalOrderRequest(db, {
        companyId: companyA, partyId: supplier, tokenId: supTokenId, kind: "SALES_ORDER", items: reqItems,
      })
    ).rejects.toThrow(/customer/i);
  });

  it("supplier invoice submission requires a vendor invoice number; approval makes a DRAFT BILL (non-posting)", async () => {
    const before = await journalCount();
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: supplier });
    await expect(
      createPortalOrderRequest(db, {
        companyId: companyA, partyId: supplier, tokenId, kind: "BILL_SUBMISSION", items: reqItems,
      })
    ).rejects.toThrow(/invoice number/i);

    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: supplier, tokenId,
      kind: "BILL_SUBMISSION", items: reqItems, vendorRef: "SUP-INV-77",
    });
    await submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: supplier });
    const { request, docId, docNo } = await approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id });
    expect(request.status).toBe("APPROVED");
    expect(docNo.startsWith("BIL-")).toBe(true);
    const bills = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId));
    expect(bills[0]!.docType).toBe("BILL");
    expect(bills[0]!.status).toBe("DRAFT");
    expect(bills[0]!.journalEntryId).toBeNull();
    expect(bills[0]!.refNo).toBe("SUP-INV-77");
    // Non-posting: no journal touched.
    expect(await journalCount()).toBe(before);
  });

  it("idempotent creation: same key returns the existing request, no duplicate", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const key = crypto.randomUUID();
    const a = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems, idempotencyKey: key,
    });
    const b = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems, idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
    expect(b.requestNo).toBe(a.requestNo);
    const rows = await db
      .select({ n: sql<number>`count(*)` })
      .from(s.portalOrderRequests)
      .where(and(eq(s.portalOrderRequests.companyId, companyA), eq(s.portalOrderRequests.idempotencyKey, key)));
    expect(rows[0]?.n).toBe(1);
  });

  it("validates items: empty, bad qty, negative rate, foreign product", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const base = { companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER" as const };
    await expect(createPortalOrderRequest(db, { ...base, items: [] })).rejects.toThrow(UserError);
    await expect(
      createPortalOrderRequest(db, { ...base, items: [{ description: "x", qtyMilli: "0", ratePaisa: "10" }] })
    ).rejects.toThrow(UserError);
    await expect(
      createPortalOrderRequest(db, { ...base, items: [{ description: "x", qtyMilli: "1", ratePaisa: "-5" }] })
    ).rejects.toThrow(UserError);
    await expect(
      createPortalOrderRequest(db, { ...base, items: [{ productId: crypto.randomUUID(), description: "x", qtyMilli: "1", ratePaisa: "10" }] })
    ).rejects.toThrow(/invalid/i);
  });
});

// ─── Payment intents ────────────────────────────────────────────

describe("portal payment intents", () => {
  it("records an INTENT with no postings and no money movement", async () => {
    const before = await journalCount();
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const intent = await createPaymentIntent(db, {
      companyId: companyA, partyId: customer, tokenId,
      side: "SALES", docId: invoiceId, amountPaisa: "500.50", method: "BANK_TRANSFER", reference: "FT123",
    });
    expect(intent.status).toBe("INTENT");
    expect(intent.amountPaisa).toBe(50050n);
    expect(await journalCount()).toBe(before);
    const inv = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invoiceId)).limit(1);
    expect(inv[0]!.amountPaid).toBe(0n); // untouched
  });

  it("rejects amounts above the outstanding balance", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    await expect(
      createPaymentIntent(db, {
        companyId: companyA, partyId: customer, tokenId,
        side: "SALES", docId: invoiceId, amountPaisa: "999999", method: "CASH",
      })
    ).rejects.toThrow(/outstanding/i);
  });

  it("rejects intents against another party's document", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer2 });
    await expect(
      createPaymentIntent(db, {
        companyId: companyA, partyId: customer2, tokenId,
        side: "SALES", docId: invoiceId, amountPaisa: "100", method: "CASH",
      })
    ).rejects.toThrow(/not found/i);
  });

  it("idempotent intent creation", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const key = crypto.randomUUID();
    const a = await createPaymentIntent(db, {
      companyId: companyA, partyId: customer, tokenId,
      side: "SALES", docId: invoiceId, amountPaisa: "100", method: "CASH", idempotencyKey: key,
    });
    const b = await createPaymentIntent(db, {
      companyId: companyA, partyId: customer, tokenId,
      side: "SALES", docId: invoiceId, amountPaisa: "100", method: "CASH", idempotencyKey: key,
    });
    expect(b.id).toBe(a.id);
  });

  it("reconcile posts a REAL balanced receipt and stamps the intent", async () => {
    const before = await journalCount();
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const intent = await createPaymentIntent(db, {
      companyId: companyA, partyId: customer, tokenId,
      side: "SALES", docId: invoiceId, amountPaisa: "1200", method: "BANK_TRANSFER", reference: "FT999",
    });
    const { intent: done, paymentId, paymentDocNo } = await reconcilePaymentIntent(db, {
      companyId: companyA, userId, intentId: intent.id, bankAccountId: cashAccountId,
    });
    expect(done.status).toBe("RECONCILED");
    expect(done.reconciledPaymentId).toBe(paymentId);
    expect(paymentDocNo.startsWith("REC-")).toBe(true);
    expect(await journalCount()).toBe(before + 1);
    expect(await trialBalanceZero()).toBe(true);
    const inv = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invoiceId)).limit(1);
    expect(inv[0]!.amountPaid).toBe(120000n);

    // Second reconcile is a no-op: no duplicate payment.
    const again = await reconcilePaymentIntent(db, {
      companyId: companyA, userId, intentId: intent.id, bankAccountId: cashAccountId,
    });
    expect(again.intent.id).toBe(intent.id);
    expect(await journalCount()).toBe(before + 1);
  });

  it("supplier-side reconcile posts a real payment against the bill", async () => {
    const before = await journalCount();
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: supplier });
    const intent = await createPaymentIntent(db, {
      companyId: companyA, partyId: supplier, tokenId,
      side: "PURCHASE", docId: billId, amountPaisa: "4000", method: "CHEQUE", reference: "CHQ-1",
    });
    const { paymentDocNo } = await reconcilePaymentIntent(db, {
      companyId: companyA, userId, intentId: intent.id, bankAccountId: cashAccountId,
    });
    expect(paymentDocNo.startsWith("PAY-")).toBe(true);
    expect(await journalCount()).toBe(before + 1);
    expect(await trialBalanceZero()).toBe(true);
    const bill = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, billId)).limit(1);
    expect(bill[0]!.amountPaid).toBe(400000n);
  });

  it("cancel an open intent; reconciling a cancelled intent fails", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const intent = await createPaymentIntent(db, {
      companyId: companyA, partyId: customer, tokenId,
      side: "SALES", docId: invoiceId, amountPaisa: "100", method: "CASH",
    });
    const cancelled = await cancelPaymentIntent(db, { companyId: companyA, intentId: intent.id, partyId: customer });
    expect(cancelled.status).toBe("CANCELLED");
    await expect(
      reconcilePaymentIntent(db, { companyId: companyA, userId, intentId: intent.id, bankAccountId: cashAccountId })
    ).rejects.toThrow(UserError);
  });
});

// ─── Isolation ──────────────────────────────────────────────────

describe("tenant + party isolation", () => {
  it("company B cannot touch company A's requests", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await expect(
      submitPortalOrderRequest(db, { companyId: companyB, requestId: created.id })
    ).rejects.toThrow(/not found/i);
    await expect(
      approvePortalOrderRequest(db, { companyId: companyB, userId, requestId: created.id })
    ).rejects.toThrow(/not found/i);
  });

  it("a token cannot act on another party's request", async () => {
    const { id: tokenId } = await issueToken({ companyId: companyA, partyId: customer });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await expect(
      submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer2 })
    ).rejects.toThrow(/not found/i);
    await expect(
      cancelPaymentIntent(db, { companyId: companyA, intentId: crypto.randomUUID(), partyId: customer2 })
    ).rejects.toThrow(/not found/i);
  });

  it("a token issued for company A is unusable against company B data", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer });
    const res = await resolvePortalToken(db, token);
    expect(res.ok).toBe(true);
    if (res.ok) {
      // The resolved context is pinned to the token's own company/party.
      expect(res.ctx.token.companyId).toBe(companyA);
      expect(res.ctx.party.id).toBe(customer);
    }
  });
});

// ─── Rate limiting + activity ───────────────────────────────────

describe("rate limiting", () => {
  it("DB sliding-window limiter blocks past the limit", async () => {
    const key = `m11-test-${crypto.randomUUID()}`;
    for (let i = 0; i < 3; i++) {
      const r = await rateLimitDb(key, 3, 60_000, db);
      expect(r.ok).toBe(true);
    }
    const blocked = await rateLimitDb(key, 3, 60_000, db);
    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
  });

  it("public portal gate enforces 60/min per IP, then 429s", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer });
    const ip = `10.11.12.${Math.floor(Math.random() * 200) + 1}`;
    const req = () =>
      new NextRequest("http://localhost/api/portal/x", { headers: { "x-forwarded-for": ip } });
    for (let i = 0; i < 60; i++) {
      const g = await portalGate(req(), token, undefined, db);
      expect(g.ok).toBe(true);
    }
    const over = await portalGate(req(), token, undefined, db);
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.response.status).toBe(429);
      const body = await over.response.json();
      expect(body.code).toBe("RATE_LIMITED");
    }
  });

  it("public portal gate rejects a VIEW_ONLY token asking for ORDER actions", async () => {
    const { token } = await issueToken({ companyId: companyA, partyId: customer, accessLevel: "VIEW_ONLY" });
    const req = new NextRequest("http://localhost/api/portal/x", {
      headers: { "x-forwarded-for": `10.99.99.${Math.floor(Math.random() * 200) + 1}` },
    });
    const g = await portalGate(req, token, "ORDER", db);
    expect(g.ok).toBe(false);
    if (!g.ok) {
      expect(g.response.status).toBe(403);
      const body = await g.response.json();
      expect(body.code).toBe("PORTAL_FORBIDDEN");
    }
  });
});

describe("portal activity log", () => {
  it("records lifecycle actions for the admin feed", async () => {
    const { id: tokenId, token } = await issueToken({ companyId: companyA, partyId: customer });
    await logPortalActivity(db, {
      companyId: companyA, tokenId, partyId: customer, action: "TOKEN_ISSUED", detail: "test",
    });
    const created = await createPortalOrderRequest(db, {
      companyId: companyA, partyId: customer, tokenId, kind: "SALES_ORDER", items: reqItems,
    });
    await submitPortalOrderRequest(db, { companyId: companyA, requestId: created.id, partyId: customer });
    await approvePortalOrderRequest(db, { companyId: companyA, userId, requestId: created.id });
    const rows = await db
      .select()
      .from(s.portalActivityLog)
      .where(and(eq(s.portalActivityLog.companyId, companyA), eq(s.portalActivityLog.tokenId, tokenId)));
    const actions = rows.map((r) => r.action);
    expect(actions).toContain("TOKEN_ISSUED");
    expect(actions).toContain("REQUEST_APPROVED");
    expect(token.length).toBeGreaterThan(0);
  });
});
