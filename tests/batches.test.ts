import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { productSchema } from "@/lib/validators";
import { setBundleComponents } from "@/lib/bundles";
import {
  normalizeExpiry,
  addBatchStock,
  getProductBatches,
  productHasBatches,
  expiryAlerts,
} from "@/lib/batches";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
let customerId = "";
let p1 = ""; // batch-tracked: Paracetamol
let p2 = ""; // plain product, never batched
let p4 = ""; // FIFO ordering product
let p6 = ""; // bundle component with batches
let kit = ""; // bundle of 2 x p6

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Batch Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  p1 = crypto.randomUUID();
  p2 = crypto.randomUUID();
  p4 = crypto.randomUUID();
  p6 = crypto.randomUUID();
  kit = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Batch Supplier" },
    { id: customerId, companyId, kind: "CUSTOMER", name: "Batch Customer" },
  ]);
  await db.insert(s.products).values([
    { id: p1, companyId, sku: "PARA-500", name: "Paracetamol 500mg", unit: "PCS", salePrice: parseMoney("10") },
    { id: p2, companyId, sku: "PLAIN-1", name: "Plain Gauze", unit: "PCS", salePrice: parseMoney("5") },
    { id: p4, companyId, sku: "FIFO-1", name: "FIFO Tabs", unit: "PCS", salePrice: parseMoney("8") },
    { id: p6, companyId, sku: "SCREW-1", name: "Kit Screw", unit: "PCS", salePrice: parseMoney("2") },
    { id: kit, companyId, sku: "KIT-1", name: "Repair Kit", unit: "PCS", salePrice: parseMoney("50") },
  ]);
  await setBundleComponents(db, companyId, kit, [{ productId: p6, qty: "2" }]);
});

afterAll(() => cleanup());

// ─── helpers ────────────────────────────────────────────────

function isoLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function daysFromNow(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return isoLocal(d);
}

type BatchOpts = { batchNo?: string; expiryDate?: string | null; batchId?: string | null };

async function postPurchase(
  productId: string,
  qty: string,
  rate: string,
  docType: "BILL" | "RETURN" = "BILL",
  batch: BatchOpts = {}
): Promise<void> {
  const items: DocItemInput[] = [
    { productId, description: "test", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, docType);
    const docId = crypto.randomUUID();
    await tx.insert(s.purchaseDocs).values({
      id: docId, companyId, branchId, partyId: supplierId, docType, docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId, docNo, docType,
      date: new Date(),
      items: totals.items.map((i) => ({
        ...i,
        trackStock: true,
        batchNo: batch.batchNo ?? null,
        expiryDate: batch.expiryDate ?? null,
        batchId: batch.batchId ?? null,
      })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
  });
}

async function postSale(
  productId: string,
  qty: string,
  rate: string,
  docType: "INVOICE" | "RETURN" = "INVOICE",
  batchId: string | null = null
): Promise<void> {
  const items: DocItemInput[] = [
    { productId, description: "test", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, docType);
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType, docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo, docType,
      date: new Date(),
      items: totals.items.map((i) => ({ ...i, trackStock: true, batchId })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
  });
}

async function stockQty(productId: string): Promise<bigint> {
  const r = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return r[0]?.qty ?? 0n;
}

async function batchQty(productId: string, batchNo: string): Promise<bigint | null> {
  const r = await db
    .select()
    .from(s.productBatches)
    .where(
      and(
        eq(s.productBatches.companyId, companyId),
        eq(s.productBatches.productId, productId),
        eq(s.productBatches.batchNo, batchNo)
      )
    )
    .limit(1);
  return r[0] ? r[0].qtyThousandths : null;
}

async function batchIdOf(productId: string, batchNo: string): Promise<string> {
  const r = await db
    .select({ id: s.productBatches.id })
    .from(s.productBatches)
    .where(
      and(
        eq(s.productBatches.companyId, companyId),
        eq(s.productBatches.productId, productId),
        eq(s.productBatches.batchNo, batchNo)
      )
    )
    .limit(1);
  if (!r[0]) throw new Error(`batch ${batchNo} not found`);
  return r[0].id;
}

async function journalCount(): Promise<number> {
  const r = await db
    .select({ id: s.journalEntries.id })
    .from(s.journalEntries)
    .where(eq(s.journalEntries.companyId, companyId));
  return r.length;
}

// ─── purchase batch creation ────────────────────────────────

describe("purchase batch creation", () => {
  it("creates a batch row and tops it up on repeat receipt", async () => {
    await postPurchase(p1, "10", "100", "BILL", { batchNo: "B-001", expiryDate: daysFromNow(60) });
    expect(await batchQty(p1, "B-001")).toBe(parseQty("10"));
    expect(await stockQty(p1)).toBe(parseQty("10"));

    // same batch again, no expiry this time: qty tops up, expiry retained
    await postPurchase(p1, "5", "110", "BILL", { batchNo: "B-001" });
    expect(await batchQty(p1, "B-001")).toBe(parseQty("15"));
    const rows = await getProductBatches(db, companyId, p1);
    expect(rows.find((r) => r.batchNo === "B-001")?.expiryDate).toBe(daysFromNow(60));

    // a different batch_no is a separate row
    await postPurchase(p1, "7", "100", "BILL", { batchNo: "B-002" });
    expect(await batchQty(p1, "B-002")).toBe(parseQty("7"));
    expect(await stockQty(p1)).toBe(parseQty("22"));
  });

  it("leaves products without batch info untracked", async () => {
    await postPurchase(p2, "50", "20");
    expect(await productHasBatches(db, companyId, p2)).toBe(false);
    expect(await stockQty(p2)).toBe(parseQty("50"));
  });
});

// ─── expiry validation ──────────────────────────────────────

describe("expiry validation", () => {
  it("normalizeExpiry accepts blank/null and real dates", () => {
    expect(normalizeExpiry(null)).toBeNull();
    expect(normalizeExpiry("")).toBeNull();
    expect(normalizeExpiry("   ")).toBeNull();
    expect(normalizeExpiry("2027-02-28")).toBe("2027-02-28");
  });

  it("normalizeExpiry rejects malformed or impossible dates", () => {
    for (const bad of ["2027-13-01", "2027-02-30", "27-01-01", "2027/01/01", "next Tuesday", "2027-1-1"]) {
      expect(() => normalizeExpiry(bad), bad).toThrow(UserError);
    }
  });

  it("a purchase with an invalid expiry is rejected atomically", async () => {
    const before = await stockQty(p1);
    const journals = await journalCount();
    await expect(
      postPurchase(p1, "3", "100", "BILL", { batchNo: "BAD-1", expiryDate: "2027-13-40" })
    ).rejects.toThrow(UserError);
    expect(await batchQty(p1, "BAD-1")).toBeNull();
    expect(await stockQty(p1)).toBe(before);
    expect(await journalCount()).toBe(journals);
  });
});

// ─── FIFO deduction ─────────────────────────────────────────

describe("sales batch deduction", () => {
  it("deducts FIFO: earliest expiry first, NULL expiries last", async () => {
    await postPurchase(p4, "10", "50", "BILL", { batchNo: "EARLY", expiryDate: daysFromNow(10) });
    await postPurchase(p4, "10", "50", "BILL", { batchNo: "LATE", expiryDate: daysFromNow(50) });
    await postPurchase(p4, "10", "50", "BILL", { batchNo: "NOEXP" });
    expect(await stockQty(p4)).toBe(parseQty("30"));

    await postSale(p4, "25", "8");
    expect(await batchQty(p4, "EARLY")).toBe(0n);
    expect(await batchQty(p4, "LATE")).toBe(0n);
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("5"));
    expect(await stockQty(p4)).toBe(parseQty("5"));
  });

  it("an explicit batch choice deducts only that batch", async () => {
    const noexpId = await batchIdOf(p4, "NOEXP");
    await postSale(p4, "4", "8", "INVOICE", noexpId);
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("1"));
    expect(await batchQty(p4, "EARLY")).toBe(0n);
    expect(await stockQty(p4)).toBe(parseQty("1"));
  });

  it("insufficient batch qty is rejected atomically and names the batch + product", async () => {
    const noexpId = await batchIdOf(p4, "NOEXP");
    const before = await stockQty(p4);
    const journals = await journalCount();
    let message = "";
    try {
      await postSale(p4, "20", "8", "INVOICE", noexpId);
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      message = (e as Error).message;
    }
    expect(message).toContain("NOEXP");
    expect(message).toContain("FIFO Tabs");
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("1"));
    expect(await stockQty(p4)).toBe(before);
    expect(await journalCount()).toBe(journals);
  });

  it("a sales return restores the chosen batch", async () => {
    const noexpId = await batchIdOf(p4, "NOEXP");
    await postSale(p4, "2", "8", "RETURN", noexpId);
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("3"));
    expect(await stockQty(p4)).toBe(parseQty("3"));
  });

  it("a sales return without a batch restores stock only", async () => {
    await postSale(p4, "1", "8", "RETURN", null);
    expect(await stockQty(p4)).toBe(parseQty("4"));
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("3"));
  });
});

// ─── purchase returns ───────────────────────────────────────

describe("purchase returns", () => {
  it("deducts the chosen batch on a purchase return", async () => {
    const noexpId = await batchIdOf(p4, "NOEXP");
    await postPurchase(p4, "1", "50", "RETURN", { batchId: noexpId });
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("2"));
    expect(await stockQty(p4)).toBe(parseQty("3"));
  });

  it("rejects a purchase return that exceeds the chosen batch", async () => {
    const noexpId = await batchIdOf(p4, "NOEXP");
    await expect(postPurchase(p4, "50", "50", "RETURN", { batchId: noexpId })).rejects.toThrow(UserError);
    expect(await batchQty(p4, "NOEXP")).toBe(parseQty("2"));
  });
});

// ─── bundle + batch composition ────────────────────────────

describe("bundle explosion composes with batch deduction", () => {
  it("selling a bundle deducts FIFO from the component's batches", async () => {
    await postPurchase(p6, "20", "30", "BILL", { batchNo: "KB-1" });
    await postSale(kit, "5", "50"); // 5 kits x 2 screws = 10 screws, FIFO from KB-1
    expect(await stockQty(p6)).toBe(parseQty("10"));
    expect(await batchQty(p6, "KB-1")).toBe(parseQty("10"));
    expect(await stockQty(kit)).toBe(0n); // bundles hold no stock
    expect(await productHasBatches(db, companyId, kit)).toBe(false);
  });
});

// ─── expiry alerts ──────────────────────────────────────────

describe("expiry alerts", () => {
  it("lists expired batches and batches expiring within 30 days", async () => {
    const pid = crypto.randomUUID();
    await db.insert(s.products).values({
      id: pid, companyId, sku: "ALERT-1", name: "Alert Syrup", unit: "BTL", salePrice: parseMoney("60"),
    });
    await db.transaction(async (tx) => {
      await addBatchStock(tx, companyId, pid, "EXP", daysFromNow(-5), parseQty("10"));
      await addBatchStock(tx, companyId, pid, "SOON", daysFromNow(10), parseQty("5"));
      await addBatchStock(tx, companyId, pid, "LATER", daysFromNow(60), parseQty("5"));
      await addBatchStock(tx, companyId, pid, "NOEXPIRY", null, parseQty("5"));
    });
    // zero-qty batch: insert directly (addBatchStock skips qty <= 0)
    await db.insert(s.productBatches).values({
      id: crypto.randomUUID(), companyId, productId: pid,
      batchNo: "EMPTY", expiryDate: daysFromNow(10), qtyThousandths: 0n,
    });

    const { expired, expiring } = await expiryAlerts(db, companyId, 30);
    const expiredNos = expired.map((r) => r.batchNo);
    const expiringNos = expiring.map((r) => r.batchNo);
    expect(expiredNos).toContain("EXP");
    expect(expiringNos).toContain("SOON");
    expect(expiredNos).not.toContain("LATER");
    expect(expiringNos).not.toContain("LATER");
    expect(expiredNos).not.toContain("NOEXPIRY");
    expect(expiringNos).not.toContain("NOEXPIRY");
    expect([...expiredNos, ...expiringNos]).not.toContain("EMPTY"); // no remaining qty
    const exp = expired.find((r) => r.batchNo === "EXP")!;
    expect(exp.productName).toBe("Alert Syrup");
    expect(exp.qtyThousandths).toBe(parseQty("10"));
  });
});

// ─── product location ───────────────────────────────────────

describe("godown/rack location", () => {
  it("is saved and returned on products", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.products).values({
      id, companyId, sku: "LOC-1", name: "Located Widget", unit: "PCS",
      location: "Godown A · Rack 3",
    });
    const rows = await db.select().from(s.products).where(eq(s.products.id, id)).limit(1);
    expect(rows[0]?.location).toBe("Godown A · Rack 3");
    await db.update(s.products).set({ location: null }).where(eq(s.products.id, id));
    const rows2 = await db.select().from(s.products).where(eq(s.products.id, id)).limit(1);
    expect(rows2[0]?.location).toBeNull();
  });

  it("passes through the product validator", () => {
    const parsed = productSchema.parse({
      sku: "V-1", name: "Validator Widget", location: "  Godown B  ",
    });
    expect(parsed.location).toBe("Godown B");
  });
});

// sanity: SYS codes still used (no hardcoded account codes in new code paths)
describe("accounting sanity", () => {
  it("posting a batched sale keeps the journal balanced", async () => {
    const before = await journalCount();
    await postPurchase(p2, "10", "20", "BILL", { batchNo: "PLN-1", expiryDate: daysFromNow(90) });
    await postSale(p2, "3", "30");
    expect(await journalCount()).toBe(before + 2);
    const entryRows = await db
      .select({ entryId: s.journalLines.entryId, debit: s.journalLines.debit, credit: s.journalLines.credit })
      .from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
      .where(eq(s.journalEntries.companyId, companyId));
    const byEntry = new Map<string, { d: bigint; c: bigint }>();
    for (const r of entryRows) {
      const e = byEntry.get(r.entryId) ?? { d: 0n, c: 0n };
      e.d += r.debit; e.c += r.credit;
      byEntry.set(r.entryId, e);
    }
    for (const [id, e] of byEntry) {
      expect(e.d, `entry ${id}`).toBe(e.c);
      expect(e.d, `entry ${id}`).toBeGreaterThan(0n);
    }
  });
});
