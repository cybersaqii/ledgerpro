import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { parseDateOnly } from "@/lib/route-helpers";
import { isDateLocked, lockMessage, periodLockError, getPeriodLock } from "@/lib/period";
import { convertSalesDoc } from "@/lib/doc-actions";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let productId = "";

const LOCK = parseDateOnly("2026-06-30");

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Lock Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: customerId, companyId, kind: "CUSTOMER", name: "Lock Customer" });
  await db.insert(s.products).values({
    id: productId, companyId, sku: "LOCK-1", name: "Lock Product", unit: "PCS",
    purchasePrice: parseMoney("100"), salePrice: parseMoney("150"), trackStock: false,
  });
});

afterAll(() => cleanup());

async function setLock(d: Date | null) {
  await db.update(s.companies).set({ lockedUntil: d }).where(eq(s.companies.id, companyId));
}

async function createQuotation(date: Date): Promise<string> {
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "QUOTATION"));
  const id = crypto.randomUUID();
  const items: DocItemInput[] = [{
    productId, description: "Lock Product", qtyMilli: parseQty("1"),
    ratePaisa: parseMoney("150"), discountPaisa: 0n, taxBps: 0,
  }];
  const totals = computeTotals(items, 0n);
  await db.insert(s.salesDocs).values({
    id, companyId, branchId, partyId: customerId, docType: "QUOTATION", docNo,
    date, status: "DRAFT",
    subtotal: totals.subtotal, discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    createdById: userId,
  });
  await db.insert(s.salesDocItems).values(totals.items.map((i) => ({
    id: crypto.randomUUID(), docId: id, productId: i.productId, description: i.description,
    qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
    taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
  })));
  return id;
}

describe("period lock helpers", () => {
  it("isDateLocked: open when no lock, locked on/before the lock date", () => {
    expect(isDateLocked(new Date(), null)).toBe(false);
    expect(isDateLocked(parseDateOnly("2026-06-30"), LOCK)).toBe(true); // on the date
    expect(isDateLocked(parseDateOnly("2026-01-15"), LOCK)).toBe(true); // before
    expect(isDateLocked(parseDateOnly("2026-07-01"), LOCK)).toBe(false); // after
  });

  it("lockMessage names the lock date", () => {
    expect(lockMessage(LOCK)).toContain("2026-06-30");
  });

  it("periodLockError reads the company lock from the db", async () => {
    await setLock(null);
    expect(await getPeriodLock(db, companyId)).toBeNull();
    expect(await periodLockError(db, companyId, parseDateOnly("2020-01-01"))).toBeNull();

    await setLock(LOCK);
    expect(await periodLockError(db, companyId, parseDateOnly("2026-06-30"))).toContain("2026-06-30");
    expect(await periodLockError(db, companyId, new Date())).toBeNull();
    await setLock(null);
  });
});

describe("period lock enforcement on convert", () => {
  it("blocks converting a quotation dated in the locked period", async () => {
    await setLock(LOCK);
    const srcId = await createQuotation(parseDateOnly("2026-03-10"));
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId }))
    ).rejects.toThrow(/locked up to 2026-06-30/);
    await setLock(null);
  });

  it("allows converting a quotation dated after the lock", async () => {
    await setLock(LOCK);
    const srcId = await createQuotation(parseDateOnly("2026-07-05"));
    const res = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: srcId, userId })
    );
    expect(res.docNo).toMatch(/^INV-/);
    await setLock(null);
  });
});
