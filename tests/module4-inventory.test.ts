/**
 * Module 4 — Inventory, Items & Multi-Warehouse (migration 0035).
 *
 * Lib-level coverage:
 *  1. Migration 0035: system accounts 4040 (Inventory Adjustment Gain) and
 *     6020 (Shrinkage Expense) seeded for new companies; STR- sequence seeded.
 *  2. Opening stock: one-time balanced posting Dr Inventory / Cr Opening
 *     Balance Equity (3002), sets qty + moving-average cost; double-post
 *     rejected (409 ALREADY_POSTED); per-product inventory account honored.
 *  3. Per-product GL accounts: sales revenue grouped by product revenue
 *     account; COGS/inventory grouped by per-product pairs; GRN inventory
 *     debits split by per-product inventory account.
 *  4. Per-line branch on invoices: stock deducted at the line's location;
 *     movement ledger records each line's branch.
 *  5. Transfer documents: DRAFT -> IN_TRANSIT -> RECEIVED lifecycle with
 *     in-transit visibility; CANCEL restores the source; moving-average cost
 *     conserved across the move (no value created or destroyed).
 *  6. Transfer guards: same branch, unknown product, insufficient stock,
 *     bad transitions rejected.
 *  7. Stock adjustments: omitted accountId defaults FOUND -> 4040 gain and
 *     losses -> 6020 shrinkage; explicit wrong-type account rejected.
 *  8. Movement card: chronological rows with in/out qty, running balance and
 *     average cost.
 *  9. SERVICE items never touch stock.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, asc, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap, nextDocNo } from "@/lib/setup";
import { postSalesDoc } from "@/lib/posting";
import { postGrn } from "@/lib/grn";
import { postStockAdjustment } from "@/lib/stock-adjust";
import { postOpeningStock, createStockTransfer, issueStockTransfer, receiveStockTransfer, cancelStockTransfer } from "@/lib/inventory";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchMain = "";
let branchWarehouse = "";
let customer = "";
let widget = ""; // INVENTORY, default GL accounts
let gadget = ""; // INVENTORY, custom revenue/cogs/inventory accounts
let service = ""; // SERVICE, never stocked

const now = () => new Date("2026-10-01T10:00:00Z");

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "M4 Test Co" });
  const res = await setupCompany(db, companyId);
  branchMain = res.branchId;
  // Second location: a warehouse (Module 4.2 — branches ARE the locations).
  branchWarehouse = crypto.randomUUID();
  await db.insert(s.branches).values({
    id: branchWarehouse, companyId, name: "Central Warehouse",
    isDefault: false, locationType: "WAREHOUSE",
  });

  // Custom GL accounts for the gadget (per-product overrides).
  const mkAcct = async (code: string, name: string, type: string) => {
    const id = crypto.randomUUID();
    await db.insert(s.accounts).values({ id, companyId, code, name, type });
    return id;
  };
  const gadgetRevenue = await mkAcct("4120", "Gadget Sales", "INCOME"); // 4110 claimed by Module 9 SYS account (Gain on Disposal)
  const gadgetCogs = await mkAcct("6120", "Gadget COGS", "EXPENSE");
  const gadgetInv = await mkAcct("1210", "Gadget Inventory", "ASSET");

  const mkProduct = async (sku: string, name: string, extra: Record<string, unknown>) => {
    const id = crypto.randomUUID();
    await db.insert(s.products).values({
      id, companyId, sku, name, unit: "PCS",
      purchasePrice: parseMoney("10"), salePrice: parseMoney("100"),
      trackStock: true, itemType: "INVENTORY", ...extra,
    } as never);
    return id;
  };
  widget = await mkProduct("WIDGET", "Widget", {});
  gadget = await mkProduct("GADGET", "Gadget", {
    revenueAccountId: gadgetRevenue, cogsAccountId: gadgetCogs, inventoryAccountId: gadgetInv,
  });
  service = await mkProduct("SERVICE", "Installation", {
    trackStock: false, itemType: "SERVICE",
  });

  customer = crypto.randomUUID();
  await db.insert(s.parties).values({
    id: customer, companyId, kind: "CUSTOMER", name: "Test Customer", isActive: true,
  });
});

afterAll(() => cleanup());

async function accountId(code: string): Promise<string> {
  const map = await db.transaction((tx) => accountMap(tx, companyId));
  const id = map[code];
  if (!id) throw new Error(`account ${code} missing`);
  return id;
}

/** Net (debit − credit) per account code for a journal entry. */
async function entrySums(entryId: string): Promise<Map<string, bigint>> {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  const out = new Map<string, bigint>();
  for (const l of lines) {
    const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
    out.set(a.code, (out.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
  }
  return out;
}

async function stockOf(productId: string, branchId: string): Promise<{ qty: bigint; avg: bigint }> {
  const [r] = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return { qty: r ? BigInt(r.qty) : 0n, avg: r ? BigInt(r.avgCost) : 0n };
}

/** Seed stock directly (no journal) for tests that only need quantities. */
async function seedStock(productId: string, branchId: string, qty: string, avg: string) {
  // stock_levels has no company_id — tenancy rides on the branch.
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId, branchId,
    qty: parseQty(qty), avgCost: parseMoney(avg),
  });
}

function item(productId: string | null, qty: string, rate: string): DocItemInput {
  return { productId, description: "M4 test item", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 };
}

async function expectUserError(p: Promise<unknown>, code: string, status?: number) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).code).toBe(code);
    if (status !== undefined) expect((e as UserError).status).toBe(status);
    return;
  }
  throw new Error(`expected UserError ${code}, but the call succeeded`);
}

// ---------------------------------------------------------------------------
// 1. Migration 0035 — system accounts + STR sequence
// ---------------------------------------------------------------------------
describe("migration 0035: system accounts and sequences", () => {
  it("seeds Inventory Adjustment Gain (4040) and Shrinkage Expense (6020)", async () => {
    const map = await db.transaction((tx) => accountMap(tx, companyId));
    expect(map[SYS.ADJUSTMENT_GAIN]).toBeTruthy();
    expect(map[SYS.SHRINKAGE]).toBeTruthy();
    const [g] = await db.select().from(s.accounts)
      .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, SYS.ADJUSTMENT_GAIN))).limit(1);
    const [x] = await db.select().from(s.accounts)
      .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, SYS.SHRINKAGE))).limit(1);
    expect(g.type).toBe("INCOME");
    expect(x.type).toBe("EXPENSE");
    expect(Number(g.isSystem)).toBe(1);
  });

  it("seeds the STR- transfer document sequence", async () => {
    const no = await db.transaction((tx) => nextDocNo(tx, companyId, "STOCK_TRANSFER"));
    expect(no).toMatch(/^STR-/);
  });

  it("products.item_type defaults to INVENTORY with a CHECK constraint", async () => {
    const [p] = await db.select({ itemType: s.products.itemType })
      .from(s.products).where(eq(s.products.id, widget)).limit(1);
    expect(p.itemType).toBe("INVENTORY");
    await expect(
      db.insert(s.products).values({
        id: crypto.randomUUID(), companyId, sku: "BAD1", name: "Bad", unit: "PCS",
        purchasePrice: 0n, salePrice: 0n, trackStock: false,
        itemType: "BOGUS",
      } as never)
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Opening stock — one-time balanced posting
// ---------------------------------------------------------------------------
describe("opening stock", () => {
  it("posts Dr Inventory / Cr Opening Equity, sets qty and average cost", async () => {
    const { entryId } = await db.transaction((tx) =>
      postOpeningStock(tx, {
        companyId, branchId: branchMain, productId: widget,
        qtyMilli: parseQty("50"), unitCostPaisa: parseMoney("12"), date: now(), createdById: userId,
      })
    );
    const sums = await entrySums(entryId);
    // 50 × Rs 12 = Rs 600
    expect(sums.get(SYS.INVENTORY)).toBe(parseMoney("600"));
    expect(sums.get(SYS.OPENING_EQUITY)).toBe(-parseMoney("600"));
    const st = await stockOf(widget, branchMain);
    expect(st.qty).toBe(parseQty("50"));
    expect(st.avg).toBe(parseMoney("12"));
  });

  it("rejects a second opening-stock post for the same product (409)", async () => {
    await expectUserError(
      db.transaction((tx) =>
        postOpeningStock(tx, {
          companyId, branchId: branchMain, productId: widget,
          qtyMilli: parseQty("1"), unitCostPaisa: parseMoney("1"), date: now(), createdById: userId,
        })
      ),
      "ALREADY_POSTED",
      409
    );
  });

  it("honors the product's own inventory account", async () => {
    const { entryId } = await db.transaction((tx) =>
      postOpeningStock(tx, {
        companyId, branchId: branchMain, productId: gadget,
        qtyMilli: parseQty("10"), unitCostPaisa: parseMoney("20"), date: now(), createdById: userId,
      })
    );
    const sums = await entrySums(entryId);
    expect(sums.get("1210")).toBe(parseMoney("200"));
    expect(sums.get(SYS.INVENTORY) ?? 0n).toBe(0n);
    const st = await stockOf(gadget, branchMain);
    expect(st.avg).toBe(parseMoney("20"));
  });

  it("rejects zero quantity and unknown products", async () => {
    await expectUserError(
      db.transaction((tx) =>
        postOpeningStock(tx, {
          companyId, branchId: branchMain, productId: service,
          qtyMilli: 0n, unitCostPaisa: parseMoney("5"), date: now(), createdById: userId,
        })
      ),
      "VALIDATION_ERROR",
      422
    );
    await expectUserError(
      db.transaction((tx) =>
        postOpeningStock(tx, {
          companyId, branchId: branchMain, productId: crypto.randomUUID(),
          qtyMilli: parseQty("1"), unitCostPaisa: parseMoney("5"), date: now(), createdById: userId,
        })
      ),
      "NOT_FOUND",
      404
    );
  });
});

// ---------------------------------------------------------------------------
// 3. Per-product GL accounts in the sales journal
// ---------------------------------------------------------------------------
describe("per-product accounts in sales posting", () => {
  it("groups revenue by product revenue account and COGS/inventory by pair", async () => {
    // gadget stock: 10 @ Rs 20 at main (from opening stock above)
    const totals = computeTotals([item(gadget, "2", "150"), item(widget, "1", "100")], 0n, 0n);
    const docId = crypto.randomUUID();
    const entryId = await db.transaction((tx) =>
      postSalesDoc(tx, {
        companyId, branchId: branchMain, partyId: customer, docId, docNo: "INV-M4-1",
        docType: "INVOICE", date: now(),
        items: totals.items.map((i) => ({ ...i, trackStock: true })),
        discountTotal: 0n, freightTotal: 0n, taxTotal: 0n,
        grandTotal: totals.grandTotal, createdById: userId,
      })
    );
    const sums = await entrySums(entryId);
    // gadget: 2 × 150 = 300 → revenue 4110; widget: 1 × 100 = 100 → 4000
    expect(sums.get("4120")).toBe(-parseMoney("300"));
    expect(sums.get(SYS.SALES)).toBe(-parseMoney("100"));
    // gadget COGS: 2 × 20 = 40 → 6120; widget COGS: 1 × 12 = 12 → 5000
    expect(sums.get("6120")).toBe(parseMoney("40"));
    expect(sums.get(SYS.COGS)).toBe(parseMoney("12"));
    // inventory credits: gadget 40 → 1210; widget 12 → 1200
    expect(sums.get("1210")).toBe(-parseMoney("40"));
    expect(sums.get(SYS.INVENTORY)).toBe(-parseMoney("12"));
    // journal still balances
    let net = 0n;
    for (const v of sums.values()) net += v;
    expect(net).toBe(0n);
  });
});

// ---------------------------------------------------------------------------
// 4. Per-line branch on invoices
// ---------------------------------------------------------------------------
describe("per-line branch (location) on invoices", () => {
  it("deducts stock at each line's own branch and records movements per branch", async () => {
    await seedStock(widget, branchWarehouse, "30", "12");
    const beforeMain = await stockOf(widget, branchMain);
    const totals = computeTotals([item(widget, "5", "100"), item(widget, "7", "100")], 0n, 0n);
    const docId = crypto.randomUUID();
    await db.transaction((tx) =>
      postSalesDoc(tx, {
        companyId, branchId: branchMain, partyId: customer, docId, docNo: "INV-M4-2",
        docType: "INVOICE", date: now(),
        items: totals.items.map((i, idx) => ({
          ...i, trackStock: true, branchId: idx === 1 ? branchWarehouse : null,
        })),
        discountTotal: 0n, freightTotal: 0n, taxTotal: 0n,
        grandTotal: totals.grandTotal, createdById: userId,
      })
    );
    const afterMain = await stockOf(widget, branchMain);
    const afterWh = await stockOf(widget, branchWarehouse);
    // gadget test sold 1 widget at main (50 − 1); now another 5 → 44
    expect(afterMain.qty).toBe(beforeMain.qty - parseQty("5"));
    expect(afterWh.qty).toBe(parseQty("23")); // 30 − 7
    // movement ledger: two INVOICE rows, one per branch
    const moves = await db
      .select()
      .from(s.stockMovements)
      .where(and(eq(s.stockMovements.docId, docId), eq(s.stockMovements.txnType, "INVOICE")));
    expect(moves.length).toBe(2);
    const byBranch = new Map(moves.map((m) => [m.branchId, m]));
    expect(byBranch.get(branchMain)!.outQty.toString()).toBe(parseQty("5").toString());
    expect(byBranch.get(branchWarehouse)!.outQty.toString()).toBe(parseQty("7").toString());
  });
});

// ---------------------------------------------------------------------------
// 5–6. Transfer documents: lifecycle + guards
// ---------------------------------------------------------------------------
describe("stock transfer documents", () => {
  it("runs DRAFT -> IN_TRANSIT -> RECEIVED with in-transit visibility and conserved value", async () => {
    // widget at main: 44 @ 12 (avg Rs 12); warehouse: 23 @ 12
    const beforeMain = await stockOf(widget, branchMain);
    const beforeWh = await stockOf(widget, branchWarehouse);
    const valueBefore = beforeMain.qty * beforeMain.avg + beforeWh.qty * beforeWh.avg;

    const { id, docNo } = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
        date: now(), createdById: userId,
        lines: [{ productId: widget, qtyMilli: parseQty("10") }],
      })
    );
    expect(docNo).toMatch(/^STR-/);
    // DRAFT moves nothing.
    expect((await stockOf(widget, branchMain)).qty).toBe(beforeMain.qty);

    await db.transaction((tx) => issueStockTransfer(tx, companyId, id));
    let st = await stockOf(widget, branchMain);
    expect(st.qty).toBe(beforeMain.qty - parseQty("10"));
    // in-transit: destination unchanged — stock is "on the truck"
    expect((await stockOf(widget, branchWarehouse)).qty).toBe(beforeWh.qty);
    const [doc] = await db.select().from(s.stockTransferDocs).where(eq(s.stockTransferDocs.id, id)).limit(1);
    expect(doc.status).toBe("IN_TRANSIT");
    // issue captured the source average cost on the line
    const [line] = await db.select().from(s.stockTransferLines).where(eq(s.stockTransferLines.transferId, id)).limit(1);
    expect(BigInt(line.costPaisa)).toBe(beforeMain.avg);

    await db.transaction((tx) => receiveStockTransfer(tx, companyId, id));
    st = await stockOf(widget, branchWarehouse);
    expect(st.qty).toBe(beforeWh.qty + parseQty("10"));
    // half-up moving average: (23×12 + 10×12) / 33 = 12
    expect(st.avg).toBe(parseMoney("12"));
    const [doc2] = await db.select().from(s.stockTransferDocs).where(eq(s.stockTransferDocs.id, id)).limit(1);
    expect(doc2.status).toBe("RECEIVED");

    // value conserved: no paisa created or destroyed
    const afterMain = await stockOf(widget, branchMain);
    const afterWh = await stockOf(widget, branchWarehouse);
    const valueAfter = afterMain.qty * afterMain.avg + afterWh.qty * afterWh.avg;
    expect(valueAfter).toBe(valueBefore);

    // movements: TRANSFER_OUT at main, TRANSFER_IN at warehouse
    const moves = await db.select().from(s.stockMovements)
      .where(eq(s.stockMovements.docId, id));
    const types = moves.map((m) => `${m.txnType}@${m.branchId}`).sort();
    expect(types).toContain(`TRANSFER_OUT@${branchMain}`);
    expect(types).toContain(`TRANSFER_IN@${branchWarehouse}`);
  });

  it("cancelling an in-transit transfer restores the source", async () => {
    const before = await stockOf(widget, branchMain);
    const { id } = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
        date: now(), createdById: userId,
        lines: [{ productId: widget, qtyMilli: parseQty("4") }],
      })
    );
    await db.transaction((tx) => issueStockTransfer(tx, companyId, id));
    expect((await stockOf(widget, branchMain)).qty).toBe(before.qty - parseQty("4"));
    await db.transaction((tx) => cancelStockTransfer(tx, companyId, id));
    expect((await stockOf(widget, branchMain)).qty).toBe(before.qty);
    const [doc] = await db.select().from(s.stockTransferDocs).where(eq(s.stockTransferDocs.id, id)).limit(1);
    expect(doc.status).toBe("CANCELLED");
  });

  it("rejects bad transfers and bad transitions", async () => {
    // same branch
    await expectUserError(
      db.transaction((tx) =>
        createStockTransfer(tx, {
          companyId, fromBranchId: branchMain, toBranchId: branchMain,
          date: now(), createdById: userId, lines: [{ productId: widget, qtyMilli: parseQty("1") }],
        })
      ), "VALIDATION_ERROR", 422);
    // unknown product
    await expectUserError(
      db.transaction((tx) =>
        createStockTransfer(tx, {
          companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
          date: now(), createdById: userId, lines: [{ productId: crypto.randomUUID(), qtyMilli: parseQty("1") }],
        })
      ), "NOT_FOUND", 404);
    // insufficient stock at issue time
    const { id } = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
        date: now(), createdById: userId, lines: [{ productId: widget, qtyMilli: parseQty("999999") }],
      })
    );
    await expectUserError(db.transaction((tx) => issueStockTransfer(tx, companyId, id)), "INSUFFICIENT_STOCK", 422);
    // receive before issue
    const { id: id2 } = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
        date: now(), createdById: userId, lines: [{ productId: widget, qtyMilli: parseQty("1") }],
      })
    );
    await expectUserError(db.transaction((tx) => receiveStockTransfer(tx, companyId, id2)), "INVALID_STATE", 409);
    // issue twice
    await db.transaction((tx) => issueStockTransfer(tx, companyId, id2));
    await expectUserError(db.transaction((tx) => issueStockTransfer(tx, companyId, id2)), "INVALID_STATE", 409);
    await db.transaction((tx) => cancelStockTransfer(tx, companyId, id2));
  });

  it("multi-line drafts issue and receive every line", async () => {
    // gadget at main: 8 @ 20 (10 opening − 2 sold); widget at main: 34
    const { id } = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId, fromBranchId: branchMain, toBranchId: branchWarehouse,
        date: now(), createdById: userId, notes: "multi-line",
        lines: [
          { productId: widget, qtyMilli: parseQty("2") },
          { productId: gadget, qtyMilli: parseQty("3") },
        ],
      })
    );
    await db.transaction((tx) => issueStockTransfer(tx, companyId, id));
    await db.transaction((tx) => receiveStockTransfer(tx, companyId, id));
    const whWidget = await stockOf(widget, branchWarehouse);
    const whGadget = await stockOf(gadget, branchWarehouse);
    const mainGadget = await stockOf(gadget, branchMain);
    expect(whWidget.qty).toBe(parseQty("35")); // 33 + 2
    expect(whGadget.qty).toBe(parseQty("3"));
    expect(whGadget.avg).toBe(parseMoney("20"));
    expect(mainGadget.qty).toBe(parseQty("5")); // 8 − 3
  });
});

// ---------------------------------------------------------------------------
// 7. Stock adjustments — default system accounts
// ---------------------------------------------------------------------------
describe("stock adjustment default accounts", () => {
  async function adjustmentEntryId(adjustmentId: string): Promise<string> {
    const [a] = await db.select({ journalEntryId: s.stockAdjustments.journalEntryId })
      .from(s.stockAdjustments).where(eq(s.stockAdjustments.id, adjustmentId)).limit(1);
    if (!a?.journalEntryId) throw new Error("adjustment journal missing");
    return a.journalEntryId;
  }

  it("FOUND without an account posts Dr Inventory / Cr 4040 gain", async () => {
    const before = await stockOf(widget, branchWarehouse);
    const { id } = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId: branchWarehouse, reason: "FOUND",
        date: now(), createdById: userId,
        lines: [{ productId: widget, qtyMilli: parseQty("5") }],
      })
    );
    const sums = await entrySums(await adjustmentEntryId(id));
    expect(sums.get(SYS.INVENTORY)).toBe(before.avg * parseQty("5") / 1000n);
    expect(sums.get(SYS.ADJUSTMENT_GAIN)).toBe(-(before.avg * parseQty("5") / 1000n));
    expect((await stockOf(widget, branchWarehouse)).qty).toBe(before.qty + parseQty("5"));
  });

  it("BREAKAGE without an account posts Dr 6020 shrinkage / Cr Inventory", async () => {
    const before = await stockOf(widget, branchWarehouse);
    const { id } = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId: branchWarehouse, reason: "BREAKAGE",
        date: now(), createdById: userId,
        lines: [{ productId: widget, qtyMilli: -parseQty("2") }],
      })
    );
    const sums = await entrySums(await adjustmentEntryId(id));
    expect(sums.get(SYS.SHRINKAGE)).toBe(before.avg * parseQty("2") / 1000n);
    expect(sums.get(SYS.INVENTORY)).toBe(-(before.avg * parseQty("2") / 1000n));
  });

  it("rejects an explicit account of the wrong type for the direction", async () => {
    const gainId = await accountId(SYS.ADJUSTMENT_GAIN); // INCOME
    await expectUserError(
      db.transaction((tx) =>
        postStockAdjustment(tx, {
          companyId, branchId: branchWarehouse, reason: "BREAKAGE",
          accountId: gainId, date: now(), createdById: userId,
          lines: [{ productId: widget, qtyMilli: -parseQty("1") }],
        })
      ),
      "VALIDATION_ERROR",
      422
    );
  });
});

// ---------------------------------------------------------------------------
// 8. Movement card — chronological, running balance + average
// ---------------------------------------------------------------------------
describe("movement card", () => {
  it("lists every movement for a product/branch in order with running balance", async () => {
    const rows = await db
      .select()
      .from(s.stockMovements)
      .where(and(eq(s.stockMovements.companyId, companyId), eq(s.stockMovements.productId, widget), eq(s.stockMovements.branchId, branchMain)))
      .orderBy(asc(s.stockMovements.date), asc(s.stockMovements.createdAt));
    const types = rows.map((r) => r.txnType);
    expect(types[0]).toBe("OPENING");
    expect(types).toContain("INVOICE");
    expect(types).toContain("TRANSFER_OUT");
    // running balance never negative and matches stock_levels
    let bal = 0n;
    for (const r of rows) {
      bal += BigInt(r.inQty) - BigInt(r.outQty);
      expect(BigInt(r.balanceQty)).toBe(bal);
    }
    const st = await stockOf(widget, branchMain);
    expect(bal).toBe(st.qty);
    // every row is keyed to this company/branch/product
    for (const r of rows) {
      expect(r.companyId).toBe(companyId);
      expect(r.branchId).toBe(branchMain);
    }
  });
});

// ---------------------------------------------------------------------------
// 9. GRN honors per-product inventory accounts
// ---------------------------------------------------------------------------
describe("GRN per-product inventory accounts", () => {
  it("debits each product's own inventory account", async () => {
    const docId = crypto.randomUUID();
    const entryId = await db.transaction((tx) =>
      postGrn(tx, {
        companyId, branchId: branchMain, partyId: customer, docId, docNo: "GRN-M4-1",
        date: now(),
        items: [
          { productId: gadget, description: "g", qtyOrdered: 0n, qtyReceived: parseQty("4"), qtyDamaged: 0n, ratePaisa: parseMoney("25"), discountPaisa: 0n, taxBps: 0, trackStock: true },
          { productId: widget, description: "w", qtyOrdered: 0n, qtyReceived: parseQty("6"), qtyDamaged: 0n, ratePaisa: parseMoney("11"), discountPaisa: 0n, taxBps: 0, trackStock: true },
        ],
        createdById: userId,
      })
    );
    const sums = await entrySums(entryId);
    expect(sums.get("1210")).toBe(parseMoney("100")); // 4 × 25
    expect(sums.get(SYS.INVENTORY)).toBe(parseMoney("66")); // 6 × 11
  });
});

// ---------------------------------------------------------------------------
// 10. SERVICE items never touch stock
// ---------------------------------------------------------------------------
describe("service items", () => {
  it("a SERVICE sale posts revenue with no stock movement", async () => {
    const totals = computeTotals([item(service, "1", "500")], 0n, 0n);
    const docId = crypto.randomUUID();
    const entryId = await db.transaction((tx) =>
      postSalesDoc(tx, {
        companyId, branchId: branchMain, partyId: customer, docId, docNo: "INV-M4-SVC",
        docType: "INVOICE", date: now(),
        items: totals.items.map((i) => ({ ...i, trackStock: false })),
        discountTotal: 0n, freightTotal: 0n, taxTotal: 0n,
        grandTotal: totals.grandTotal, createdById: userId,
      })
    );
    const sums = await entrySums(entryId);
    expect(sums.get(SYS.SALES)).toBe(-parseMoney("500"));
    // no stock_levels row, no movements
    const [lvl] = await db.select().from(s.stockLevels)
      .where(and(eq(s.stockLevels.productId, service), eq(s.stockLevels.branchId, branchMain))).limit(1);
    expect(lvl).toBeUndefined();
    const moves = await db.select().from(s.stockMovements).where(eq(s.stockMovements.docId, docId));
    expect(moves.length).toBe(0);
  });
});
