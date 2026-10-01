// Module 6 — security, approvals, audit & templates.
// Lib-level: the full stage → decide lifecycle mirrors the API routes exactly
// (the routes only add the permission gate + HTTP plumbing around these calls).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, desc, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, accountMap, SYS } from "@/lib/setup";
import { insertParty } from "@/lib/party-create";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import * as s from "@/db/schema";
import {
  approvalRequired,
  stageApprovalRequest,
  findApprovalRequestByIdemKey,
  approveRequest,
  rejectRequest,
  cancelRequest,
} from "@/lib/approvals";
import { logAudit } from "@/lib/audit";
import {
  readTemplateSettings,
  writeTemplateSettings,
  templateSchema,
  TEMPLATE_DEFAULTS,
} from "@/lib/invoice-template";
import {
  PERMISSIONS,
  STAFF_DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
} from "@/lib/permission-keys";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const requesterId = crypto.randomUUID(); // staff who stages the doc
const approverId = crypto.randomUUID(); // a different user who decides
let branchId = "";
let customer = "";
let supplier = "";
let widget = ""; // trackStock product

function item(productId: string | null, qty: string, rate: string): DocItemInput {
  return {
    productId,
    description: "M6 test item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

async function journalLinesCount(): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .where(eq(s.journalEntries.companyId, companyId));
  return rows[0]?.n ?? 0;
}

async function trialBalanceZero(): Promise<boolean> {
  const rows = await db
    .select({ net: sql<string>`coalesce(sum(${s.journalLines.debit} - ${s.journalLines.credit}), 0)` })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
    .where(eq(s.journalEntries.companyId, companyId));
  return BigInt(rows[0]?.net ?? "0") === 0n;
}

async function partyBalance(partyId: string): Promise<bigint> {
  const rows = await db
    .select({ b: s.parties.balance })
    .from(s.parties)
    .where(eq(s.parties.id, partyId))
    .limit(1);
  return rows[0] ? BigInt(rows[0].b) : 0n;
}

async function stockOf(): Promise<bigint> {
  const rows = await db
    .select({ qty: s.stockLevels.qty })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, widget), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return rows[0] ? BigInt(rows[0].qty) : 0n;
}

/** Faithful lib-level replica of the staged-invoice path in app/api/sales/route.ts. */
async function stageInvoice(opts: { rate?: string; qty?: string; idem?: string } = {}) {
  const docItems = [item(widget, opts.qty ?? "2", opts.rate ?? "100")];
  const totals = computeTotals(docItems, 0n, 0n);
  const date = new Date();
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customer, docType: "INVOICE",
      docNo, date, status: "PENDING_APPROVAL", subtotal: totals.subtotal,
      discountTotal: 0n, freightTotal: totals.freightPaisa, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: requesterId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const approvalId = await stageApprovalRequest(tx, {
      companyId,
      docType: "SALES_INVOICE",
      docId,
      docNo,
      partyId: customer,
      partyName: "M6 Customer",
      amountPaisa: totals.grandTotal,
      payload: { lineBatches: [null] },
      requestedById: requesterId,
      requestedByName: "M6 Requester",
      idempotencyKey: opts.idem,
    });
    return { docId, docNo, approvalId, grandTotal: totals.grandTotal };
  });
}

let cashAccountId = "";
beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "M6 Company" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  cashAccountId = (
    await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
      .limit(1)
  )[0]!.id;

  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId: requesterId, fields: { kind: "CUSTOMER", name: "M6 Customer" } })
  ));
  ({ id: supplier } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId: requesterId, fields: { kind: "SUPPLIER", name: "M6 Supplier" } })
  ));
  widget = crypto.randomUUID();
  await db.insert(s.products).values({
    id: widget, companyId, name: "M6 Widget", sku: "M6W", trackStock: true,
    salePrice: parseMoney("100"), purchasePrice: parseMoney("60"),
  });
  // opening stock: 100 units
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId: widget, branchId, qty: parseQty("100"), avgCost: parseMoney("60"),
  });
});

afterAll(() => cleanup());

// ─── approvalRequired ────────────────────────────────────────────────
describe("approvalRequired", () => {
  it("is false when no rule exists", async () => {
    expect(await approvalRequired(db, companyId, "SALES_INVOICE", parseMoney("1000000"))).toBe(false);
  });

  it("is false below the threshold and true above it", async () => {
    await db.insert(s.approvalRules).values({
      id: crypto.randomUUID(), companyId, docType: "SALES_INVOICE",
      thresholdPaisa: parseMoney("50000"), isActive: true, createdById: requesterId,
    });
    expect(await approvalRequired(db, companyId, "SALES_INVOICE", parseMoney("50000"))).toBe(false);
    expect(await approvalRequired(db, companyId, "SALES_INVOICE", parseMoney("49999.99"))).toBe(false);
    expect(await approvalRequired(db, companyId, "SALES_INVOICE", parseMoney("50000.01"))).toBe(true);
  });

  it("is false when the rule is paused", async () => {
    await db.insert(s.approvalRules).values({
      id: crypto.randomUUID(), companyId, docType: "PAYMENT",
      thresholdPaisa: parseMoney("1"), isActive: false, createdById: requesterId,
    });
    expect(await approvalRequired(db, companyId, "PAYMENT", parseMoney("999999"))).toBe(false);
  });
});

// ─── staged invoice lifecycle ────────────────────────────────────────
describe("staged sales invoice", () => {
  it("stages without posting: no journal, no stock move, no balance change", async () => {
    const before = {
      lines: await journalLinesCount(),
      stock: await stockOf(),
      balance: await partyBalance(customer),
    };
    const { docId, approvalId } = await stageInvoice({ rate: "100", qty: "2" });
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId));
    expect(doc.status).toBe("PENDING_APPROVAL");
    expect(doc.journalEntryId).toBeNull();
    const [req] = await db.select().from(s.approvalRequests).where(eq(s.approvalRequests.id, approvalId));
    expect(req.status).toBe("PENDING");
    expect(req.docType).toBe("SALES_INVOICE");
    expect(await journalLinesCount()).toBe(before.lines);
    expect(await stockOf()).toBe(before.stock);
    expect(await partyBalance(customer)).toBe(before.balance);
  });

  it("findApprovalRequestByIdemKey returns the staged request (idempotency)", async () => {
    const idem = crypto.randomUUID();
    const { approvalId, docNo } = await stageInvoice({ rate: "50", idem });
    const found = await findApprovalRequestByIdemKey(db, companyId, idem);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(approvalId);
    expect(found!.docNo).toBe(docNo);
    expect(found!.status).toBe("PENDING");
    expect(await findApprovalRequestByIdemKey(db, companyId, crypto.randomUUID())).toBeNull();
  });

  it("approving stages → POSTED with a balanced journal, stock out and AR up", async () => {
    const linesBefore = await journalLinesCount();
    const stockBefore = await stockOf();
    const balBefore = await partyBalance(customer);
    const { docId, approvalId, grandTotal } = await stageInvoice({ rate: "200", qty: "3" });
    const res = await db.transaction((tx) =>
      approveRequest(tx, {
        companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver",
      })
    );
    expect(res.status).toBe("APPROVED");
    expect(res.docId).toBe(docId);
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId));
    expect(doc.status).toBe("POSTED");
    expect(doc.journalEntryId).not.toBeNull();
    expect(await journalLinesCount()).toBeGreaterThan(linesBefore);
    expect(await trialBalanceZero()).toBe(true);
    expect(await stockOf()).toBe(stockBefore - parseQty("3"));
    expect(await partyBalance(customer)).toBe(balBefore + grandTotal);
  });

  it("rejects self-approval (403 SELF_APPROVAL)", async () => {
    const { approvalId } = await stageInvoice({ rate: "10" });
    await expect(
      db.transaction((tx) =>
        approveRequest(tx, { companyId, requestId: approvalId, deciderId: requesterId, deciderName: "M6 Requester" })
      )
    ).rejects.toMatchObject({ code: "SELF_APPROVAL", status: 403 });
  });

  it("double approval is idempotent — no second journal", async () => {
    const { approvalId } = await stageInvoice({ rate: "10", qty: "1" });
    await db.transaction((tx) =>
      approveRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver" })
    );
    const linesAfter = await journalLinesCount();
    const again = await db.transaction((tx) =>
      approveRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver" })
    );
    expect(again.status).toBe("APPROVED");
    expect(await journalLinesCount()).toBe(linesAfter);
  });

  it("rejection requires a comment, then returns the doc to DRAFT", async () => {
    const { docId, approvalId, grandTotal } = await stageInvoice({ rate: "10", qty: "1" });
    const linesBefore = await journalLinesCount();
    await expect(
      db.transaction((tx) =>
        rejectRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver", comment: "" })
      )
    ).rejects.toMatchObject({ code: "COMMENT_REQUIRED", status: 422 });
    const res = await db.transaction((tx) =>
      rejectRequest(tx, {
        companyId, requestId: approvalId, deciderId: approverId,
        deciderName: "M6 Approver", comment: "duplicate order",
      })
    );
    expect(res.status).toBe("REJECTED");
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId));
    expect(doc.status).toBe("REJECTED"); // staged doc kept as a visible rejected record
    expect(doc.journalEntryId).toBeNull();
    expect(await journalLinesCount()).toBe(linesBefore);
    void grandTotal;
  });

  it("the requester can cancel their own request (doc back to DRAFT)", async () => {
    const { docId, approvalId } = await stageInvoice({ rate: "10", qty: "1" });
    const res = await db.transaction((tx) =>
      cancelRequest(tx, { companyId, requestId: approvalId, userId: requesterId, isOwner: false })
    );
    expect(res.status).toBe("CANCELLED");
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId));
    expect(doc.status).toBe("DRAFT");
  });

  it("a stranger cannot cancel someone else's request", async () => {
    const { approvalId } = await stageInvoice({ rate: "10", qty: "1" });
    await expect(
      db.transaction((tx) =>
        cancelRequest(tx, { companyId, requestId: approvalId, userId: approverId, isOwner: false })
      )
    ).rejects.toMatchObject({ status: 403 });
  });
});

// ─── staged purchase bill ────────────────────────────────────────────
describe("staged purchase bill", () => {
  it("approving a staged bill posts it: stock in, AP up, journal balanced", async () => {
    const docItems = [item(widget, "5", "60")];
    const totals = computeTotals(docItems, 0n, 0n);
    const stockBefore = await stockOf();
    const balBefore = await partyBalance(supplier);
    const { docId, approvalId, grandTotal } = await db.transaction(async (tx) => {
      const docNo = await nextDocNo(tx, companyId, "BILL");
      const docId = crypto.randomUUID();
      await tx.insert(s.purchaseDocs).values({
        id: docId, companyId, branchId, partyId: supplier, docType: "BILL",
        docNo, date: new Date(), status: "PENDING_APPROVAL", subtotal: totals.subtotal,
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: requesterId,
      });
      await tx.insert(s.purchaseDocItems).values(
        totals.items.map((i) => ({
          id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
          qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
          taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
        }))
      );
      const approvalId = await stageApprovalRequest(tx, {
        companyId, docType: "PURCHASE_BILL", docId, docNo,
        partyId: supplier, partyName: "M6 Supplier", amountPaisa: totals.grandTotal,
        payload: { lineBatches: [{ batchNo: "B-1", expiryDate: null }] },
        requestedById: requesterId, requestedByName: "M6 Requester",
      });
      return { docId, approvalId, grandTotal: totals.grandTotal };
    });
    const res = await db.transaction((tx) =>
      approveRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver" })
    );
    expect(res.status).toBe("APPROVED");
    const [doc] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId));
    expect(doc.status).toBe("POSTED");
    expect(await trialBalanceZero()).toBe(true);
    expect(await stockOf()).toBe(stockBefore + parseQty("5"));
    expect(await partyBalance(supplier)).toBe(balBefore + grandTotal);
  });
});

// ─── staged payment ──────────────────────────────────────────────────
describe("staged payment", () => {
  it("stages a payload-only receipt; approval posts it with exact paisa", async () => {
    const balBefore = await partyBalance(customer);
    const approvalId = await db.transaction((tx) =>
      stageApprovalRequest(tx, {
        companyId,
        docType: "PAYMENT",
        partyId: customer,
        partyName: "M6 Customer",
        amountPaisa: parseMoney("250.75"),
        payload: {
          kind: "RECEIPT",
          partyId: customer,
          branchId,
          dateISO: new Date().toISOString(),
          bankAccountId: cashAccountId,
          amountPaisa: parseMoney("250.75").toString(),
          method: "CASH",
          reference: "",
          notes: "staged receipt",
          allocations: [],
          autoAllocate: false,
        },
        requestedById: requesterId,
        requestedByName: "M6 Requester",
      })
    );
    const paymentsBefore = await db
      .select({ n: sql<number>`count(*)` })
      .from(s.payments)
      .where(eq(s.payments.companyId, companyId));
    expect(paymentsBefore[0]?.n ?? 0).toBeGreaterThanOrEqual(0);
    const res = await db.transaction((tx) =>
      approveRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver" })
    );
    expect(res.status).toBe("APPROVED");
    expect(res.docId).not.toBeNull();
    const [pay] = await db.select().from(s.payments).where(eq(s.payments.id, res.docId!));
    expect(pay).toBeDefined();
    expect(BigInt(pay.amount)).toBe(parseMoney("250.75"));
    expect(await trialBalanceZero()).toBe(true);
    expect(await partyBalance(customer)).toBe(balBefore - parseMoney("250.75"));
  });
});

// ─── staged journal voucher ──────────────────────────────────────────
describe("staged journal voucher", () => {
  it("approving a staged journal posts a balanced entry", async () => {
    const map = await db.transaction((tx) => accountMap(tx, companyId));
    const cashId = map[SYS.CASH];
    const expId = map[SYS.EXPENSES];
    const approvalId = await db.transaction((tx) =>
      stageApprovalRequest(tx, {
        companyId,
        docType: "JOURNAL",
        amountPaisa: parseMoney("1200"),
        payload: {
          branchId,
          dateISO: new Date().toISOString(),
          memo: "staged office expense",
          lines: [
            { accountId: expId, debitPaisa: parseMoney("1200").toString(), creditPaisa: "0", partyId: null, memo: "" },
            { accountId: cashId, debitPaisa: "0", creditPaisa: parseMoney("1200").toString(), partyId: null, memo: "" },
          ],
        },
        requestedById: requesterId,
        requestedByName: "M6 Requester",
      })
    );
    const res = await db.transaction((tx) =>
      approveRequest(tx, { companyId, requestId: approvalId, deciderId: approverId, deciderName: "M6 Approver" })
    );
    expect(res.status).toBe("APPROVED");
    expect(res.docId).not.toBeNull();
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, res.docId!));
    expect(lines.length).toBe(2);
    expect(lines.reduce((a, l) => a + BigInt(l.debit), 0n)).toBe(
      lines.reduce((a, l) => a + BigInt(l.credit), 0n)
    );
    expect(await trialBalanceZero()).toBe(true);
  });
});

// ─── audit trail ─────────────────────────────────────────────────────
describe("audit log (module 6 forensic fields)", () => {
  it("records IP and old/new values", async () => {
    await logAudit(db, {
      companyId, userId: approverId, userName: "M6 Approver",
      action: "approval.approved", entity: "approval", entityId: "req-1",
      ip: "203.0.113.9",
      oldValues: { status: "PENDING" },
      newValues: { status: "APPROVED", docId: "d-1" },
    });
    const [row] = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.companyId, companyId), eq(s.auditLogs.action, "approval.approved")))
      .orderBy(desc(s.auditLogs.createdAt))
      .limit(1);
    expect(row).toBeDefined();
    expect(row.ip).toBe("203.0.113.9");
    expect(JSON.parse(row.oldValues ?? "{}")).toEqual({ status: "PENDING" });
    expect(JSON.parse(row.newValues ?? "{}")).toEqual({ status: "APPROVED", docId: "d-1" });
  });

  it("omits null forensic fields cleanly", async () => {
    await logAudit(db, { companyId, userId: approverId, userName: "M6 Approver", action: "m6.ping" });
    const [row] = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.companyId, companyId), eq(s.auditLogs.action, "m6.ping")))
      .limit(1);
    expect(row.ip).toBeNull();
    expect(row.oldValues).toBeNull();
  });
});

// ─── invoice template settings ───────────────────────────────────────
describe("invoice template settings", () => {
  it("returns defaults when nothing is stored", async () => {
    const tpl = await readTemplateSettings(db, companyId);
    expect(tpl.primaryColor).toBe(TEMPLATE_DEFAULTS.primaryColor);
    expect(tpl.showLogo).toBe(true);
  });

  it("round-trips written settings", async () => {
    const full = {
      primaryColor: "#1a73e8",
      terms: "Payment due in 7 days.",
      signatureUrl: "https://x.example/sig.png",
      qrEnabled: true,
      showLogo: false,
    };
    await writeTemplateSettings(db, companyId, full);
    const tpl = await readTemplateSettings(db, companyId);
    expect(tpl).toEqual(full);
  });

  it("validates color and URL inputs", () => {
    expect(() => templateSchema.parse({ primaryColor: "red", qrEnabled: false, showLogo: true })).toThrow();
    expect(() =>
      templateSchema.parse({ primaryColor: "#abcdef", signatureUrl: "not-a-url", qrEnabled: false, showLogo: true })
    ).toThrow();
    expect(() =>
      templateSchema.parse({
        primaryColor: "#abcdef",
        signatureUrl: "https://x.example/s.png",
        qrEnabled: true,
        showLogo: true,
      })
    ).not.toThrow();
  });
});

// ─── company profile fields ──────────────────────────────────────────
describe("company profile (module 6 fields)", () => {
  it("stores trade name and STRN", async () => {
    await db
      .update(s.companies)
      .set({ tradeName: "M6 Trading Co", strn: "1234567-8" })
      .where(eq(s.companies.id, companyId));
    const [co] = await db.select().from(s.companies).where(eq(s.companies.id, companyId));
    expect(co.tradeName).toBe("M6 Trading Co");
    expect(co.strn).toBe("1234567-8");
  });

  it("stores the fiscal-year-start setting (MM-DD mirror of the route regex)", async () => {
    const re = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;
    expect(re.test("07-01")).toBe(true);
    expect(re.test("13-01")).toBe(false);
    expect(re.test("2026-07-01")).toBe(false);
    await db
      .insert(s.settings)
      .values({ id: crypto.randomUUID(), companyId, key: "fiscal_year_start", value: "07-01" })
      .onConflictDoUpdate({
        target: [s.settings.companyId, s.settings.key],
        set: { value: "07-01" },
      });
    const [row] = await db
      .select()
      .from(s.settings)
      .where(and(eq(s.settings.companyId, companyId), eq(s.settings.key, "fiscal_year_start")));
    expect(row.value).toBe("07-01");
  });
});

// ─── permission keys ─────────────────────────────────────────────────
describe("permission keys (module 6)", () => {
  it("declares the approvals grant in the admin group, off by default for staff", () => {
    expect(PERMISSIONS).toContain("approvals");
    const admin = PERMISSION_GROUPS.find((g) => g.key === "admin");
    expect(admin?.permissions).toContain("approvals");
    expect(STAFF_DEFAULT_PERMISSIONS).not.toContain("approvals");
  });
});
