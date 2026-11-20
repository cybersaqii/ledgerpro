/**
 * Phase 1 — stock idempotency (migration 0074).
 *
 * Route-level replay tests, same harness as tests/module3-idempotency.test.ts:
 * DATABASE_URL is pointed at an isolated file DB by ./qa-routes-env (imported
 * first) and requirePermission is mocked.
 *
 * Gap (live until this phase): POST /api/stock-adjustments accepted no
 * idempotency key and stock_adjustments carried none, so a double-submit
 * moved the stock twice. POST /api/stock/transfers likewise accepted no
 * key, so a double-submit moved the same quantity twice. POST
 * /api/stock/transfer-docs accepted a key but had no route-level replay, so
 * a lost race surfaced as a 500 unique violation instead of a 200 replay.
 *
 * Each test uses its own product so the tests stay independent: a replay
 * must create exactly one document and move the stock exactly once.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompany } from "@/lib/setup";
import * as s from "@/db/schema";

const hoisted = vi.hoisted(() => ({
  cid: crypto.randomUUID(),
  uid: crypto.randomUUID(),
}));

vi.mock("@/lib/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-helpers")>();
  const dbm = await import("@/lib/db");
  return {
    ...actual,
    db: dbm.db,
    requirePermission: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Tester" },
      companyId: hoisted.cid,
    }),
  };
});

async function migrateFileDb(url: string): Promise<void> {
  const client = createClient({ url });
  try {
    await client.execute(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
    );
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const version = f.replace(/\.sql$/, "");
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("--");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      for (const stmt of text.split(";").map((x) => x.trim()).filter((x) => x.length > 0)) {
        await client.execute(stmt);
      }
      await client.execute({
        sql: "INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: [version, Date.now()],
      });
    }
  } finally {
    client.close();
  }
}

type RouteDb = (typeof import("@/lib/db"))["db"];
let routeDb: RouteDb;
let adjustmentsRoute: typeof import("@/app/api/stock-adjustments/route");
let transfersRoute: typeof import("@/app/api/stock/transfers/route");
let transferDocsRoute: typeof import("@/app/api/stock/transfer-docs/route");

let branchMain = "";
let branchWarehouse = "";
const productIds = { adj: "", xfer: "", doc: "" };

async function reqJson(url: string, body: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function levelQty(productId: string, branchId: string): Promise<bigint> {
  const [r] = await routeDb
    .select({ qty: s.stockLevels.qty })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return r ? BigInt(r.qty) : 0n;
}

describe("phase 1 stock idempotency replay", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    adjustmentsRoute = await import("@/app/api/stock-adjustments/route");
    transfersRoute = await import("@/app/api/stock/transfers/route");
    transferDocsRoute = await import("@/app/api/stock/transfer-docs/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Stock Idem Co" });
    const res = await setupCompany(routeDb, hoisted.cid);
    branchMain = res.branchId;
    branchWarehouse = crypto.randomUUID();
    await routeDb.insert(s.branches).values({
      id: branchWarehouse, companyId: hoisted.cid, name: "Central Warehouse",
      isDefault: false, locationType: "WAREHOUSE",
    });
    for (const [key, sku] of [
      ["adj", "IDEM-ADJ"],
      ["xfer", "IDEM-XFER"],
      ["doc", "IDEM-DOC"],
    ] as const) {
      const id = crypto.randomUUID();
      productIds[key] = id;
      await routeDb.insert(s.products).values({
        id, companyId: hoisted.cid, sku, name: `Idem ${sku}`,
        unit: "PCS", trackStock: true, itemType: "INVENTORY",
      });
      // 100 units @ Rs 100.00/unit on hand at the main branch.
      await routeDb.insert(s.stockLevels).values({
        id: crypto.randomUUID(), productId: id, branchId: branchMain,
        qty: 100_000n, avgCost: 10_000n,
      });
    }
  }, 90000);

  it("replays POST /api/stock-adjustments with the same key: one doc, stock moved once", async () => {
    const key = crypto.randomUUID();
    const body = {
      reason: "BREAKAGE",
      date: "2026-09-30",
      lines: [{ productId: productIds.adj, qtyMilli: "-10" }],
      idempotencyKey: key,
    };
    const r1 = await adjustmentsRoute.POST(await reqJson("http://x/api/stock-adjustments", body));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await adjustmentsRoute.POST(await reqJson("http://x/api/stock-adjustments", body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.idempotentReplay).toBe(true);
    expect(j2.data.id).toBe(j1.data.id);
    expect(j2.data.docNo).toBe(j1.data.docNo);

    const rows = await routeDb
      .select({ id: s.stockAdjustments.id })
      .from(s.stockAdjustments)
      .where(eq(s.stockAdjustments.companyId, hoisted.cid));
    expect(rows).toHaveLength(1);
    // 100 − 10 once = 90. A double-apply would leave 80.
    expect(await levelQty(productIds.adj, branchMain)).toBe(90_000n);
  });

  it("replays POST /api/stock/transfers with the same key: one doc, stock moved once", async () => {
    const key = crypto.randomUUID();
    const body = {
      productId: productIds.xfer,
      fromBranchId: branchMain,
      toBranchId: branchWarehouse,
      qty: "20",
      date: "2026-09-30",
      idempotencyKey: key,
    };
    const r1 = await transfersRoute.POST(await reqJson("http://x/api/stock/transfers", body));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await transfersRoute.POST(await reqJson("http://x/api/stock/transfers", body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.idempotentReplay).toBe(true);
    expect(j2.data.transferId).toBe(j1.data.transferId);
    expect(j2.data.docNo).toBe(j1.data.docNo);

    const rows = await routeDb
      .select({ id: s.stockTransferDocs.id })
      .from(s.stockTransferDocs)
      .where(eq(s.stockTransferDocs.companyId, hoisted.cid));
    expect(rows).toHaveLength(1);
    // 100 − 20 once at source, 20 once at destination.
    expect(await levelQty(productIds.xfer, branchMain)).toBe(80_000n);
    expect(await levelQty(productIds.xfer, branchWarehouse)).toBe(20_000n);
  });

  it("replays POST /api/stock/transfer-docs with the same key: one draft, no stock moved", async () => {
    const key = crypto.randomUUID();
    const body = {
      fromBranchId: branchMain,
      toBranchId: branchWarehouse,
      date: "2026-09-30",
      lines: [{ productId: productIds.doc, qty: "5" }],
      idempotencyKey: key,
    };
    const r1 = await transferDocsRoute.POST(await reqJson("http://x/api/stock/transfer-docs", body));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await transferDocsRoute.POST(await reqJson("http://x/api/stock/transfer-docs", body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.idempotentReplay).toBe(true);
    expect(j2.data.id).toBe(j1.data.id);
    expect(j2.data.docNo).toBe(j1.data.docNo);

    const rows = await routeDb
      .select({ id: s.stockTransferDocs.id })
      .from(s.stockTransferDocs)
      .where(eq(s.stockTransferDocs.companyId, hoisted.cid));
    // One doc from this test + one from the quick-transfer test above.
    expect(rows).toHaveLength(2);
    // Drafts move no stock.
    expect(await levelQty(productIds.doc, branchMain)).toBe(100_000n);
    expect(await levelQty(productIds.doc, branchWarehouse)).toBe(0n);
  });
});
