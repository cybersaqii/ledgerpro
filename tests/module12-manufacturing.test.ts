/**
 * Module 12 — Manufacturing & BOM.
 *
 * Covers: pure cost-rollup math (scrap rounding, cost rollup), BOM
 * versioning + validation, WO lifecycle DRAFT→RELEASED→IN_PROGRESS→
 * COMPLETED (status guards), BOM snapshot immutability, component costing
 * at moving average, WIP issue journal balance, single completion journal
 * balance, idempotent issue/complete, void (stock restored + both journals
 * reversed), and void blocked when finished goods were sold.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { applyStock } from "@/lib/posting";
import * as s from "@/db/schema";
import {
  perUnitQtyWithScrap,
  requiredQtyMilli,
  rollupCost,
  createBom,
  setBomActive,
  latestActiveBom,
  createWorkOrder,
  updateWorkOrder,
  releaseWorkOrder,
  cancelWorkOrder,
  issueWorkOrder,
  completeWorkOrder,
  voidWorkOrder,
  getWorkOrderDetail,
} from "@/lib/manufacturing";
import { UserError } from "@/lib/errors";
import { parseQty } from "@/lib/qty";
import { parseMoney } from "@/lib/money";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const R = (rs: number) => BigInt(rs) * 100n; // rupees → paisa

let branchId = "";
let finished = ""; // finished good: "Steel Chair"
let steel = ""; // component: avg Rs 120/unit
let screws = ""; // component: avg Rs 2.50/unit

async function makeProduct(name: string, sku: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.products).values({
    id, companyId, sku, name, unit: "PCS", trackStock: true,
  });
  return id;
}

async function seedStock(productId: string, qtyUnits: string, avgRs: string) {
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId, branchId,
    qty: parseQty(qtyUnits), avgCost: parseMoney(avgRs),
  });
}

async function stockOf(productId: string): Promise<{ qty: bigint; avg: bigint }> {
  const [r] = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return { qty: r ? BigInt(r.qty) : 0n, avg: r ? BigInt(r.avgCost) : 0n };
}

/** Net GL movement per account code (debits − credits) for this company. */
async function glNetByCode(): Promise<Map<string, bigint>> {
  const rows = await db
    .select({ code: s.accounts.code, d: s.journalLines.debit, c: s.journalLines.credit })
    .from(s.journalLines)
    .innerJoin(s.accounts, eq(s.journalLines.accountId, s.accounts.id))
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(eq(s.journalEntries.companyId, companyId));
  const map = new Map<string, bigint>();
  for (const r of rows) map.set(r.code, (map.get(r.code) ?? 0n) + BigInt(r.d) - BigInt(r.c));
  return map;
}

async function journalSums(entryId: string): Promise<{ d: bigint; c: bigint }> {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  return {
    d: lines.reduce((a, l) => a + BigInt(l.debit), 0n),
    c: lines.reduce((a, l) => a + BigInt(l.credit), 0n),
  };
}

async function expectUserError(p: Promise<unknown>, code: string) {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).code).toBe(code);
    return;
  }
  throw new Error(`expected UserError ${code}`);
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  ({ branchId } = await setupCompany(db, companyId));
  finished = await makeProduct("Steel Chair", "FG-CHAIR");
  steel = await makeProduct("Steel Sheet", "RM-STEEL");
  screws = await makeProduct("Screws (box)", "RM-SCREW");
  await seedStock(steel, "1000", "120"); // 1000 units @ Rs 120
  await seedStock(screws, "5000", "2.50"); // 5000 units @ Rs 2.50
});

afterAll(() => cleanup());

describe("pure cost math", () => {
  it("adds scrap per unit and rounds up", () => {
    // 2.5 units + 5% scrap = 2.625 → 2625 milli (exact).
    expect(perUnitQtyWithScrap(2500n, 5)).toBe(2625n);
    // 1 unit + 3% = 1.03 → 1030 milli.
    expect(perUnitQtyWithScrap(1000n, 3)).toBe(1030n);
    // 1 milli + 1% = 1.01 milli → rounds UP to 2 milli.
    expect(perUnitQtyWithScrap(1n, 1)).toBe(2n);
    // zero scrap is identity.
    expect(perUnitQtyWithScrap(2500n, 0)).toBe(2500n);
  });
  it("computes the WO total required, rounded up", () => {
    // 10 chairs × 2.625 steel = 26.25 units → 26250 milli.
    expect(requiredQtyMilli(2500n, 5, parseQty("10"))).toBe(26250n);
    // 1 chair × 1 milli (no scrap) → 1 milli.
    expect(requiredQtyMilli(1n, 0, parseQty("1"))).toBe(1n);
  });
  it("rolls up components + labor + overhead", () => {
    expect(rollupCost([1000n, 2500n], 500n, 300n)).toEqual({ components: 3500n, total: 4300n });
  });
  it("rejects bad scrap and quantities", () => {
    expect(() => perUnitQtyWithScrap(0n, 0)).toThrow(UserError);
    expect(() => perUnitQtyWithScrap(1000n, 101)).toThrow(UserError);
    expect(() => perUnitQtyWithScrap(1000n, -1)).toThrow(UserError);
    expect(() => requiredQtyMilli(1000n, 0, 0n)).toThrow(UserError);
  });
});

describe("new SYS accounts (1250 / 2123 / 6050)", () => {
  it("setupCompany backfills the manufacturing accounts", async () => {
    const ac = await accountMap(db, companyId);
    expect(ac[SYS.WIP]).toBeTruthy();
    expect(ac[SYS.MFG_LABOR_PAYABLE]).toBeTruthy();
    expect(ac[SYS.MFG_OVERHEAD]).toBeTruthy();
    const rows = await db
      .select({ code: s.accounts.code, type: s.accounts.type })
      .from(s.accounts)
      .where(eq(s.accounts.companyId, companyId));
    const byCode = new Map(rows.map((r) => [r.code, r.type]));
    expect(byCode.get("1250")).toBe("ASSET");
    expect(byCode.get("2123")).toBe("LIABILITY");
    expect(byCode.get("6050")).toBe("EXPENSE");
  });
});

describe("BOM versioning and validation", () => {
  it("creates versions; latest active is picked", async () => {
    const v1 = await db.transaction((tx) =>
      createBom(tx, {
        companyId, productId: finished, createdById: userId,
        lines: [{ componentProductId: steel, qtyMilli: 2500n, scrapPct: 5 }],
      })
    );
    expect(v1.version).toBe(1);
    const v2 = await db.transaction((tx) =>
      createBom(tx, {
        companyId, productId: finished, createdById: userId,
        lines: [
          { componentProductId: steel, qtyMilli: 2500n, scrapPct: 5 },
          { componentProductId: screws, qtyMilli: 8000n, scrapPct: 2 },
        ],
      })
    );
    expect(v2.version).toBe(2);
    const latest = await latestActiveBom(db, companyId, finished);
    expect(latest?.version).toBe(2);
    await db.transaction((tx) => setBomActive(tx, { companyId, bomId: v2.bomId, isActive: false }));
    const afterDeactivate = await latestActiveBom(db, companyId, finished);
    expect(afterDeactivate?.version).toBe(1);
    await db.transaction((tx) => setBomActive(tx, { companyId, bomId: v2.bomId, isActive: true }));
  });
  it("rejects self-reference, duplicates, and non-stocked products", async () => {
    await expectUserError(
      db.transaction((tx) =>
        createBom(tx, { companyId, productId: finished, createdById: userId, lines: [{ componentProductId: finished, qtyMilli: 1000n }] })
      ),
      "BOM_SELF_REFERENCE"
    );
    await expectUserError(
      db.transaction((tx) =>
        createBom(tx, { companyId, productId: finished, createdById: userId, lines: [{ componentProductId: steel, qtyMilli: 1000n }, { componentProductId: steel, qtyMilli: 500n }] })
      ),
      "BOM_DUPLICATE_COMPONENT"
    );
    const service = crypto.randomUUID();
    await db.insert(s.products).values({ id: service, companyId, sku: "SRV", name: "Service", unit: "PCS", trackStock: false });
    await expectUserError(
      db.transaction((tx) =>
        createBom(tx, { companyId, productId: finished, createdById: userId, lines: [{ componentProductId: service, qtyMilli: 1000n }] })
      ),
      "MFG_NOT_STOCKED"
    );
    await expectUserError(
      db.transaction((tx) =>
        createBom(tx, { companyId, productId: finished, createdById: userId, lines: [{ componentProductId: steel, qtyMilli: 1000n, scrapPct: 101 }] })
      ),
      "BOM_BAD_SCRAP"
    );
  });
});

describe("work order lifecycle", () => {
  let woId = "";
  let issueEntryId = "";
  let completionEntryId = "";

  it("creates a DRAFT work order with an MWO- number (idempotent)", async () => {
    const key = crypto.randomUUID();
    const r1 = await db.transaction((tx) =>
      createWorkOrder(tx, { companyId, branchId, productId: finished, qtyMilli: parseQty("10"), createdById: userId, idempotencyKey: key })
    );
    expect(r1.woNo).toMatch(/^MWO-/);
    const r2 = await db.transaction((tx) =>
      createWorkOrder(tx, { companyId, branchId, productId: finished, qtyMilli: parseQty("10"), createdById: userId, idempotencyKey: key })
    );
    expect(r2.replay).toBe(true);
    expect(r2.id).toBe(r1.id);
    woId = r1.id;
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.status).toBe("DRAFT");
  });

  it("a DRAFT work order can be edited", async () => {
    await db.transaction((tx) =>
      updateWorkOrder(tx, { companyId, workOrderId: woId, notes: "rush order", qtyMilli: parseQty("10") })
    );
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.notes).toBe("rush order");
    expect(d.wo.qtyMilli).toBe(10000n);
  });

  it("release snapshots the BOM (immutable afterwards)", async () => {
    // Latest active BOM is v2: steel 2500 milli +5% scrap, screws 8000 milli +2% scrap.
    const r = await db.transaction((tx) => releaseWorkOrder(tx, { companyId, workOrderId: woId }));
    expect(r.componentCount).toBe(2);
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.status).toBe("RELEASED");
    expect(d.wo.bomVersion).toBe(2);
    // steel: ceil(2625 × 10000 / 1000) = 26250 milli; screws: ceil(8160 × 10000 / 1000) = 81600 milli.
    const steelLine = d.components.find((c) => c.componentProductId === steel)!;
    const screwLine = d.components.find((c) => c.componentProductId === screws)!;
    expect(steelLine.qtyMilli).toBe(26250n);
    expect(screwLine.qtyMilli).toBe(81600n);
    // Change the BOM afterwards (new version) — the WO snapshot must not move.
    const v3 = await db.transaction((tx) =>
      createBom(tx, { companyId, productId: finished, createdById: userId, lines: [{ componentProductId: steel, qtyMilli: 999000n }] })
    );
    const d2 = await getWorkOrderDetail(db, companyId, woId);
    expect(d2.components.find((c) => c.componentProductId === steel)!.qtyMilli).toBe(26250n);
    expect(d2.wo.bomVersion).toBe(2);
    // Deactivate v3 again so later tests keep the deterministic v2 BOM.
    await db.transaction((tx) => setBomActive(tx, { companyId, bomId: v3.bomId, isActive: false }));
  });

  it("release twice / issue from DRAFT are rejected", async () => {
    await expectUserError(
      db.transaction((tx) => releaseWorkOrder(tx, { companyId, workOrderId: woId })),
      "WO_BAD_STATUS"
    );
    const draft = await db.transaction((tx) =>
      createWorkOrder(tx, { companyId, branchId, productId: finished, qtyMilli: parseQty("1"), createdById: userId })
    );
    await expectUserError(
      db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: draft.id, createdById: userId })),
      "WO_BAD_STATUS"
    );
    await db.transaction((tx) => cancelWorkOrder(tx, { companyId, workOrderId: draft.id }));
  });

  it("issue deducts stock at moving average and posts a balanced WIP journal", async () => {
    const before = { steel: await stockOf(steel), screws: await stockOf(screws) };
    const r = await db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: woId, createdById: userId }));
    issueEntryId = r.journalEntryId;
    // steel: 26.25 units × Rs 120 = Rs 3150 → 315000p; screws: 81.6 × Rs 2.50 = Rs 204 → 20400p.
    expect(r.componentCostPaisa).toBe(R(3150) + R(204));
    const after = { steel: await stockOf(steel), screws: await stockOf(screws) };
    expect(after.steel.qty).toBe(before.steel.qty - 26250n);
    expect(after.screws.qty).toBe(before.screws.qty - 81600n);
    const sums = await journalSums(issueEntryId);
    expect(sums.d).toBe(sums.c);
    expect(sums.d).toBe(R(3150) + R(204));
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, issueEntryId));
    const ac = await accountMap(db, companyId);
    const wipLine = lines.find((l) => l.accountId === ac[SYS.WIP])!;
    const invLine = lines.find((l) => l.accountId === ac[SYS.INVENTORY])!;
    expect(BigInt(wipLine.debit)).toBe(R(3354));
    expect(BigInt(invLine.credit)).toBe(R(3354));
    // Per-line unit cost captured at moving average.
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.status).toBe("IN_PROGRESS");
    expect(d.components.find((c) => c.componentProductId === steel)!.unitCostPaisa).toBe(R(120));
    expect(d.components.find((c) => c.componentProductId === screws)!.unitCostPaisa).toBe(250n);
    // Movement ledger: component issue recorded in the stock audit trail.
    const moves = await db.select().from(s.stockMovements)
      .where(and(eq(s.stockMovements.docId, woId), eq(s.stockMovements.txnType, "MFG_ISSUE")));
    expect(moves).toHaveLength(2);
    expect(moves.every((m) => m.outQty > 0n && m.inQty === 0n)).toBe(true);
  });

  it("issue is idempotent (no double journal)", async () => {
    const r = await db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: woId, createdById: userId }));
    expect(r.replay).toBe(true);
    expect(r.journalEntryId).toBe(issueEntryId);
  });

  it("complete posts ONE balanced journal and receives FG at actual cost", async () => {
    const r = await db.transaction((tx) =>
      completeWorkOrder(tx, {
        companyId, workOrderId: woId, createdById: userId,
        laborPaisa: R(500), overheadPaisa: R(300),
      })
    );
    completionEntryId = r.journalEntryId;
    const total = R(3354) + R(500) + R(300); // components + labor + overhead
    expect(r.actualTotalCostPaisa).toBe(total);
    const sums = await journalSums(completionEntryId);
    expect(sums.d).toBe(sums.c);
    // Dr side: WIP labor + WIP overhead + FG total; Cr side mirrors.
    expect(sums.d).toBe(R(500) + R(300) + total);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, completionEntryId));
    const ac = await accountMap(db, companyId);
    const byAcct = new Map<string, { d: bigint; c: bigint }>();
    for (const l of lines) {
      const e = byAcct.get(l.accountId) ?? { d: 0n, c: 0n };
      e.d += BigInt(l.debit);
      e.c += BigInt(l.credit);
      byAcct.set(l.accountId, e);
    }
    expect(byAcct.get(ac[SYS.WIP])!.d).toBe(R(800)); // labor + overhead
    expect(byAcct.get(ac[SYS.WIP])!.c).toBe(total); // WIP cleared
    expect(byAcct.get(ac[SYS.INVENTORY])!.d).toBe(total); // FG received
    expect(byAcct.get(ac[SYS.MFG_LABOR_PAYABLE])!.c).toBe(R(500));
    expect(byAcct.get(ac[SYS.MFG_OVERHEAD])!.c).toBe(R(300));
    // FG stock: 10 units @ Rs 415.40/unit.
    const fg = await stockOf(finished);
    expect(fg.qty).toBe(parseQty("10"));
    expect(fg.avg).toBe(parseMoney("415.40"));
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.status).toBe("COMPLETED");
    // Movement ledger: finished-goods receipt recorded in the stock audit trail.
    const moves = await db.select().from(s.stockMovements)
      .where(and(eq(s.stockMovements.docId, woId), eq(s.stockMovements.txnType, "MFG_RECEIPT")));
    expect(moves).toHaveLength(1);
    expect(moves[0].inQty).toBe(parseQty("10"));
    expect(moves[0].outQty).toBe(0n);
  });

  it("WIP nets to zero and FG inventory carries the full actual cost", async () => {
    const gl = await glNetByCode();
    expect(gl.get("1250")).toBe(0n); // WIP fully cleared
    expect(gl.get("1200")).toBe(R(800)); // FG value added beyond raw materials = labor + overhead
    expect(gl.get("2123")).toBe(-R(500)); // labor payable (credit)
    expect(gl.get("6050")).toBe(-R(300)); // overhead absorbed (credit)
  });

  it("completed WO cannot be edited / re-completed / re-cancelled", async () => {
    await expectUserError(
      db.transaction((tx) => updateWorkOrder(tx, { companyId, workOrderId: woId, qtyMilli: parseQty("5") })),
      "WO_BAD_STATUS"
    );
    // Re-issue after completion is a safe idempotent replay, not an edit.
    const replay = await db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: woId, createdById: userId }));
    expect(replay.replay).toBe(true);
    expect(replay.journalEntryId).toBe(issueEntryId);
    await expectUserError(
      db.transaction((tx) => cancelWorkOrder(tx, { companyId, workOrderId: woId })),
      "WO_BAD_STATUS"
    );
  });
});

describe("void", () => {
  it("restores component stock, deducts FG, and reverses BOTH journals", async () => {
    const woId = (
      await db
        .select({ id: s.workOrders.id })
        .from(s.workOrders)
        .where(and(eq(s.workOrders.companyId, companyId), eq(s.workOrders.woNo, "MWO-0001")))
        .limit(1)
    )[0]!.id;
    const before = { steel: await stockOf(steel), screws: await stockOf(screws), fg: await stockOf(finished) };
    const r = await db.transaction((tx) => voidWorkOrder(tx, { companyId, workOrderId: woId, createdById: userId }));
    // Component stock restored exactly (re-added at issue-time average cost).
    const after = { steel: await stockOf(steel), screws: await stockOf(screws), fg: await stockOf(finished) };
    expect(after.steel.qty).toBe(before.steel.qty + 26250n);
    expect(after.screws.qty).toBe(before.screws.qty + 81600n);
    expect(after.fg.qty).toBe(before.fg.qty - parseQty("10"));
    // Both reversing journals balance and mirror the originals line-by-line.
    const origIds: Record<string, string> = {};
    {
      const rows = await db
        .select({ entryId: s.journalEntries.id, source: s.journalEntries.source })
        .from(s.journalEntries)
        .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.sourceId, woId)));
      for (const r of rows) origIds[r.source] = r.entryId;
    }
    const pairs: [string, string][] = [
      [origIds["MFG_ISSUE"]!, r.voidIssueJournalEntryId],
      [origIds["MFG_COMPLETE"]!, r.voidCompletionJournalEntryId],
    ];
    for (const [orig, rev] of pairs) {
      const sums = await journalSums(rev);
      expect(sums.d).toBe(sums.c);
      expect(sums.d).toBeGreaterThan(0n);
      const origLines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, orig));
      const revLines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, rev));
      expect(revLines).toHaveLength(origLines.length);
      // Mirror-image: each reversal line swaps debit/credit (multiset compare,
      // since an account may appear on multiple lines, e.g. WIP at completion).
      const norm = (ls: { accountId: string; debit: bigint; credit: bigint }[]) =>
        ls.map((l) => `${l.accountId}|${l.debit}|${l.credit}`).sort();
      const origNorm = norm(origLines.map((l) => ({ accountId: l.accountId, debit: BigInt(l.debit), credit: BigInt(l.credit) })));
      const revSwapped = norm(revLines.map((l) => ({ accountId: l.accountId, debit: BigInt(l.credit), credit: BigInt(l.debit) })));
      expect(revSwapped).toEqual(origNorm);
    }
    // GL is fully unwound: every manufacturing account nets to zero.
    const gl = await glNetByCode();
    expect(gl.get("1250")).toBe(0n);
    expect(gl.get("1200")).toBe(0n);
    expect(gl.get("2123")).toBe(0n);
    expect(gl.get("6050")).toBe(0n);
    const d = await getWorkOrderDetail(db, companyId, woId);
    expect(d.wo.status).toBe("VOIDED");
    // Second void is rejected.
    await expectUserError(
      db.transaction((tx) => voidWorkOrder(tx, { companyId, workOrderId: woId, createdById: userId })),
      "WO_BAD_STATUS"
    );
  });

  it("void is blocked when the finished goods were already sold", async () => {
    // Fresh WO through completion.
    const { id } = await db.transaction((tx) =>
      createWorkOrder(tx, { companyId, branchId, productId: finished, qtyMilli: parseQty("5"), createdById: userId })
    );
    await db.transaction((tx) => releaseWorkOrder(tx, { companyId, workOrderId: id }));
    await db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: id, createdById: userId }));
    await db.transaction((tx) =>
      completeWorkOrder(tx, { companyId, workOrderId: id, createdById: userId, laborPaisa: 0n, overheadPaisa: 0n })
    );
    // Sell every finished unit out of stock.
    await db.transaction((tx) =>
      applyStock(tx, branchId, [{ productId: finished, qtyMilli: -parseQty("5"), avgCostPaisa: 0n }])
    );
    // The void must fail — and atomically: component stock stays deducted,
    // no journals posted, WO still COMPLETED.
    await expectUserError(
      db.transaction((tx) => voidWorkOrder(tx, { companyId, workOrderId: id, createdById: userId })),
      "INSUFFICIENT_STOCK"
    );
    const d = await getWorkOrderDetail(db, companyId, id);
    expect(d.wo.status).toBe("COMPLETED");
    expect(d.wo.voidIssueJournalEntryId).toBeNull();
  });
});

describe("issue fails on insufficient component stock", () => {
  it("throws INSUFFICIENT_STOCK without posting anything", async () => {
    const { id } = await db.transaction((tx) =>
      createWorkOrder(tx, { companyId, branchId, productId: finished, qtyMilli: parseQty("100000"), createdById: userId })
    );
    await db.transaction((tx) => releaseWorkOrder(tx, { companyId, workOrderId: id }));
    await expectUserError(
      db.transaction((tx) => issueWorkOrder(tx, { companyId, workOrderId: id, createdById: userId })),
      "INSUFFICIENT_STOCK"
    );
    // Nothing posted: no issue journal, status still RELEASED.
    const d = await getWorkOrderDetail(db, companyId, id);
    expect(d.wo.status).toBe("RELEASED");
    expect(d.wo.issueJournalEntryId).toBeNull();
  });
});
