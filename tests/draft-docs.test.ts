/**
 * Phase 3 — draft documents (FA audit triage: save-as-draft, edit-from-detail).
 *
 * A draft posts nothing until POST /api/sales|purchases/[id]/post replays it
 * through the posting engine; a draft can be edited (PUT) with totals
 * recomputed by the same pipeline the create routes use.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { computeTotals } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { insertParty } from "@/lib/party-create";
import {
  updateDraftSalesDoc,
  updateDraftPurchaseDoc,
  postDraftSalesDoc,
  postDraftPurchaseDoc,
} from "@/lib/draft-docs";
import { salesDocSchema, purchaseDocSchema } from "@/lib/validators";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customer = "";
let supplier = "";
let widget = ""; // trackStock product, 100 units @ Rs 10 cost
let service = ""; // non-stock product

async function seedDraftSale(opts: {
  docType?: "INVOICE" | "QUOTATION" | "ORDER" | "RETURN";
  qty?: string;
  rate?: string;
  productId?: string;
  expectedDeliveryDate?: Date | null;
}): Promise<{ docId: string; docNo: string }> {
  const docType = opts.docType ?? "INVOICE";
  const items = [
    {
      productId: opts.productId ?? widget,
      description: "Draft test item",
      qtyMilli: parseQty(opts.qty ?? "2"),
      ratePaisa: parseMoney(opts.rate ?? "100"),
      discountPaisa: 0n,
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n, 0n);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, docType);
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customer, docType,
      docNo, date: new Date("2026-11-20"), status: "DRAFT",
      subtotal: totals.subtotal, discountTotal: 0n, freightTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      expectedDeliveryDate: opts.expectedDeliveryDate ?? null,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    return { docId, docNo };
  });
}

async function seedDraftBill(opts: { qty?: string; rate?: string } = {}): Promise<{ docId: string; docNo: string }> {
  const items = [
    {
      productId: widget,
      description: "Draft bill item",
      qtyMilli: parseQty(opts.qty ?? "10"),
      ratePaisa: parseMoney(opts.rate ?? "50"),
      discountPaisa: 0n,
      taxBps: 0,
    },
  ];
  const totals = computeTotals(items, 0n, 0n);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "BILL");
    const docId = crypto.randomUUID();
    await tx.insert(s.purchaseDocs).values({
      id: docId, companyId, branchId, partyId: supplier, docType: "BILL",
      docNo, date: new Date("2026-11-20"), status: "DRAFT",
      subtotal: totals.subtotal, discountTotal: 0n,
      taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.insert(s.purchaseDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    return { docId, docNo };
  });
}

async function stockOf(productId: string): Promise<bigint> {
  const rows = await db
    .select({ qty: s.stockLevels.qty })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return rows[0] ? BigInt(rows[0].qty) : 0n;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Draft Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "Draft Customer" } })
  ));
  ({ id: supplier } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "SUPPLIER", name: "Draft Supplier" } })
  ));
  widget = crypto.randomUUID();
  await db.insert(s.products).values({
    id: widget, companyId, sku: "DRAFT-WIDGET", name: "Draft Widget", unit: "PCS",
    purchasePrice: parseMoney("10"), salePrice: parseMoney("100"), trackStock: true,
  });
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId: widget, branchId, qty: parseQty("100"), avgCost: parseMoney("10"),
  });
  service = crypto.randomUUID();
  await db.insert(s.products).values({
    id: service, companyId, sku: "DRAFT-SVC", name: "Draft Service", unit: "JOB",
    purchasePrice: parseMoney("0"), salePrice: parseMoney("500"), trackStock: false,
  });
});

afterAll(() => cleanup());

describe("edit a draft invoice (PUT)", () => {
  it("recomputes totals, keeps DRAFT, posts nothing", async () => {
    const { docId } = await seedDraftSale({});
    const body = salesDocSchema.parse({
      docType: "INVOICE", partyId: customer, date: "2026-11-20",
      items: [{ productId: widget, description: "Draft test item", qty: "3", rate: "100", discount: "0", taxBps: 0 }],
    });
    const out = await updateDraftSalesDoc(db, companyId, docId, body);
    expect(out.docId).toBe(docId);
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("DRAFT");
    expect(doc.journalEntryId).toBeNull();
    expect(doc.grandTotal).toBe(parseMoney("300")); // 3 × Rs 100
    const entries = await db.select().from(s.journalEntries).where(eq(s.journalEntries.companyId, companyId));
    expect(entries).toHaveLength(0);
  });

  it("rejects editing a posted document", async () => {
    const { docId } = await seedDraftSale({});
    await db.transaction((tx) => postDraftSalesDoc(tx, companyId, docId, userId));
    const body = salesDocSchema.parse({
      docType: "INVOICE", partyId: customer, date: "2026-11-20",
      items: [{ productId: widget, description: "x", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
    });
    await expect(updateDraftSalesDoc(db, companyId, docId, body)).rejects.toMatchObject({
      code: "DOC_LOCKED",
    } as unknown as Error);
  });

  it("rejects changing the document type", async () => {
    const { docId } = await seedDraftSale({ docType: "QUOTATION" });
    const body = salesDocSchema.parse({
      docType: "INVOICE", partyId: customer, date: "2026-11-20",
      items: [{ productId: widget, description: "x", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
    });
    await expect(updateDraftSalesDoc(db, companyId, docId, body)).rejects.toBeInstanceOf(UserError);
  });

  it("stores the expected delivery date on orders only", async () => {
    const { docId } = await seedDraftSale({ docType: "ORDER" });
    const body = salesDocSchema.parse({
      docType: "ORDER", partyId: customer, date: "2026-11-20",
      expectedDeliveryDate: "2026-12-01",
      items: [{ productId: widget, description: "x", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
    });
    await updateDraftSalesDoc(db, companyId, docId, body);
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.expectedDeliveryDate?.toISOString().slice(0, 10)).toBe("2026-12-01");

    const inv = await seedDraftSale({});
    const invBody = salesDocSchema.parse({
      docType: "INVOICE", partyId: customer, date: "2026-11-20",
      expectedDeliveryDate: "2026-12-01",
      items: [{ productId: widget, description: "x", qty: "1", rate: "100", discount: "0", taxBps: 0 }],
    });
    await updateDraftSalesDoc(db, companyId, inv.docId, invBody);
    const [invDoc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, inv.docId)).limit(1);
    expect(invDoc.expectedDeliveryDate).toBeNull();
  });
});

describe("post a draft invoice", () => {
  it("posts the journal, deducts stock, bumps the party balance", async () => {
    const before = await stockOf(widget);
    const { docId, docNo } = await seedDraftSale({ qty: "2", rate: "100" });
    const [partyBefore] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    const out = await db.transaction((tx) => postDraftSalesDoc(tx, companyId, docId, userId));
    expect(out.docNo).toBe(docNo);
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("POSTED");
    expect(doc.journalEntryId).not.toBeNull();
    const [party] = await db.select().from(s.parties).where(eq(s.parties.id, customer)).limit(1);
    expect(party.balance).toBe(partyBefore.balance + parseMoney("200"));
    expect(await stockOf(widget)).toBe(before - parseQty("2"));
    // Balanced journal: Dr AR 200 / Cr Sales 200 (+ COGS legs on the tracked item).
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, doc.journalEntryId!));
    expect(lines.reduce((a, l) => a + (l.debit - l.credit), 0n)).toBe(0n);
  });

  it("rejects posting a quotation (convert it instead)", async () => {
    const { docId } = await seedDraftSale({ docType: "QUOTATION" });
    await expect(
      db.transaction((tx) => postDraftSalesDoc(tx, companyId, docId, userId))
    ).rejects.toMatchObject({ code: "DOC_NOT_POSTABLE" } as unknown as Error);
  });

  it("rejects posting twice", async () => {
    const { docId } = await seedDraftSale({});
    await db.transaction((tx) => postDraftSalesDoc(tx, companyId, docId, userId));
    await expect(
      db.transaction((tx) => postDraftSalesDoc(tx, companyId, docId, userId))
    ).rejects.toMatchObject({ code: "DOC_NOT_DRAFT" } as unknown as Error);
  });
});

describe("draft purchase bills", () => {
  it("edits a draft bill and recomputes totals", async () => {
    const { docId } = await seedDraftBill({});
    const body = purchaseDocSchema.parse({
      docType: "BILL", partyId: supplier, date: "2026-11-20", refNo: "SUP-1",
      items: [{ productId: widget, description: "Draft bill item", qty: "4", rate: "50", discount: "0", taxBps: 0 }],
    });
    await updateDraftPurchaseDoc(db, companyId, docId, body);
    const [doc] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId)).limit(1);
    expect(doc.status).toBe("DRAFT");
    expect(doc.grandTotal).toBe(parseMoney("200"));
    expect(doc.refNo).toBe("SUP-1");
  });

  it("posts a draft bill: stock in, journal posted", async () => {
    const before = await stockOf(widget);
    const { docId } = await seedDraftBill({ qty: "10", rate: "50" });
    await db.transaction((tx) => postDraftPurchaseDoc(tx, companyId, docId, userId));
    const [doc] = await db.select().from(s.purchaseDocs).where(eq(s.purchaseDocs.id, docId)).limit(1);
    expect(doc.status).toBe("POSTED");
    expect(doc.journalEntryId).not.toBeNull();
    expect(await stockOf(widget)).toBe(before + parseQty("10"));
  });

  it("rejects a draft bill carrying landed extra costs at edit time", async () => {
    const { docId } = await seedDraftBill({});
    const body = purchaseDocSchema.parse({
      docType: "BILL", partyId: supplier, date: "2026-11-20", refNo: "SUP-2",
      extraCosts: [{ label: "Freight", amount: "100" }],
      items: [{ productId: widget, description: "x", qty: "1", rate: "50", discount: "0", taxBps: 0 }],
    });
    await expect(updateDraftPurchaseDoc(db, companyId, docId, body)).rejects.toMatchObject({
      code: "DRAFT_EXTRA_COSTS",
    } as unknown as Error);
  });
});
