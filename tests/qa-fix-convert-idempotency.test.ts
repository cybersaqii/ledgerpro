/**
 * QA-sweep 2026-11-01 regression tests: idempotency keys on convert/return
 * (the convert routes had no key support, so a retried tap errored on the
 * CONVERTED stamp instead of replaying the already-created doc).
 *
 * Route-level tests import the real Next route handlers. Like
 * tests/qa-fix-idempotency.test.ts, DATABASE_URL is pointed at an isolated
 * file DB by ./qa-routes-env (imported first) before any lib module
 * evaluates the db singleton, and requirePermission/requireCompany are
 * mocked.
 *
 * Covers:
 *  (a) POST /api/sales/[id]/convert twice with the same key → exactly 1
 *      invoice, second response is 200 (replay) with the same doc id;
 *  (b) POST /api/sales/[id]/convert?action=return twice with the same key
 *      → exactly 1 return doc, second response replays;
 *  (c) POST /api/purchases/[id]/convert twice with the same key → exactly
 *      1 bill, second response replays;
 *  (d) no key → old behavior (201, NULL idempotency_key on the doc).
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
  const gate = {
    ok: true as const,
    session: { uid: hoisted.uid, name: "QA Tester" },
    companyId: hoisted.cid,
  };
  return {
    ...actual,
    db: dbm.db,
    requirePermission: async () => gate,
    requireCompany: async () => ({ ...gate, response: null }),
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
let salesConvert: typeof import("@/app/api/sales/[id]/convert/route");
let purchConvert: typeof import("@/app/api/purchases/[id]/convert/route");

let branchId = "";
let customerId = "";
let supplierId = "";
let productId = "";
let quotationId = "";
let orderId = "";

async function reqJson(url: string, body: unknown, headers?: Record<string, string>) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

describe("convert/return idempotency", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    salesConvert = await import("@/app/api/sales/[id]/convert/route");
    purchConvert = await import("@/app/api/purchases/[id]/convert/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Conv Co", businessType: "WHOLESALE" });
    await setupCompany(routeDb, hoisted.cid);
    branchId = (
      await routeDb
        .select({ id: s.branches.id })
        .from(s.branches)
        .where(eq(s.branches.companyId, hoisted.cid))
        .limit(1)
    )[0].id;
    customerId = crypto.randomUUID();
    supplierId = crypto.randomUUID();
    await routeDb.insert(s.parties).values([
      { id: customerId, companyId: hoisted.cid, name: "CC", kind: "CUSTOMER", balance: 0n },
      { id: supplierId, companyId: hoisted.cid, name: "CS", kind: "SUPPLIER", balance: 0n },
    ]);
    productId = crypto.randomUUID();
    await routeDb.insert(s.products).values({
      id: productId, companyId: hoisted.cid, sku: "CONV-1", name: "Conv widget", trackStock: false,
    });

    // Quotation (sales) + purchase order, each with one item.
    quotationId = crypto.randomUUID();
    await routeDb.insert(s.salesDocs).values({
      id: quotationId, companyId: hoisted.cid, branchId, partyId: customerId,
      docType: "QUOTATION", docNo: "QUO-0001", date: new Date("2026-10-01"),
      status: "POSTED", subtotal: 10000n, grandTotal: 10000n, createdById: hoisted.uid,
    });
    await routeDb.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: quotationId, productId, description: "Conv widget",
      qty: 1000n, rate: 10000n, discount: 0n, taxBps: 0,
    });
    orderId = crypto.randomUUID();
    await routeDb.insert(s.purchaseDocs).values({
      id: orderId, companyId: hoisted.cid, branchId, partyId: supplierId,
      docType: "ORDER", docNo: "ORD-0001", date: new Date("2026-10-01"),
      status: "ISSUED", subtotal: 10000n, grandTotal: 10000n, createdById: hoisted.uid,
    });
    await routeDb.insert(s.purchaseDocItems).values({
      id: crypto.randomUUID(), docId: orderId, productId, description: "Conv widget",
      qty: 1000n, rate: 10000n, discount: 0n, taxBps: 0,
    });
  }, 90000);

  it("sales convert replays on the same key", async () => {
    const key = "conv-sales-1";
    const r1 = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${quotationId}/convert`, { idempotencyKey: key }),
      { params: Promise.resolve({ id: quotationId }) }
    );
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${quotationId}/convert`, { idempotencyKey: key }),
      { params: Promise.resolve({ id: quotationId }) }
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.docId).toBe(j1.data.docId);
    expect(j2.data.idempotentReplay).toBe(true);
    const invoices = await routeDb
      .select()
      .from(s.salesDocs)
      .where(and(eq(s.salesDocs.companyId, hoisted.cid), eq(s.salesDocs.docType, "INVOICE")));
    expect(invoices).toHaveLength(1);
    expect(invoices[0].idempotencyKey).toBe(key);
  });

  it("sales return replays on the same key", async () => {
    // Convert a fresh quotation first (no key), then return its invoice.
    const q2 = crypto.randomUUID();
    await routeDb.insert(s.salesDocs).values({
      id: q2, companyId: hoisted.cid, branchId, partyId: customerId,
      docType: "QUOTATION", docNo: "QUO-0002", date: new Date("2026-10-01"),
      status: "POSTED", subtotal: 10000n, grandTotal: 10000n, createdById: hoisted.uid,
    });
    await routeDb.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: q2, productId, description: "Conv widget",
      qty: 1000n, rate: 10000n, discount: 0n, taxBps: 0,
    });
    const conv = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${q2}/convert`, {}),
      { params: Promise.resolve({ id: q2 }) }
    );
    expect(conv.status).toBe(201);
    const invoiceId = (await conv.json()).data.docId;

    const key = "conv-return-1";
    const r1 = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${invoiceId}/convert`, { action: "return", idempotencyKey: key }),
      { params: Promise.resolve({ id: invoiceId }) }
    );
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${invoiceId}/convert`, { action: "return", idempotencyKey: key }),
      { params: Promise.resolve({ id: invoiceId }) }
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.docId).toBe(j1.data.docId);
    expect(j2.data.idempotentReplay).toBe(true);
    const returns = await routeDb
      .select()
      .from(s.salesDocs)
      .where(and(eq(s.salesDocs.companyId, hoisted.cid), eq(s.salesDocs.docType, "RETURN")));
    expect(returns).toHaveLength(1);
  });

  it("purchases convert replays on the same key", async () => {
    const key = "conv-purch-1";
    const r1 = await purchConvert.POST(
      await reqJson(`http://t/api/purchases/${orderId}/convert`, { refNo: "V-100", idempotencyKey: key }),
      { params: Promise.resolve({ id: orderId }) }
    );
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await purchConvert.POST(
      await reqJson(`http://t/api/purchases/${orderId}/convert`, { refNo: "V-100", idempotencyKey: key }),
      { params: Promise.resolve({ id: orderId }) }
    );
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.docId).toBe(j1.data.docId);
    expect(j2.data.idempotentReplay).toBe(true);
    const bills = await routeDb
      .select()
      .from(s.purchaseDocs)
      .where(and(eq(s.purchaseDocs.companyId, hoisted.cid), eq(s.purchaseDocs.docType, "BILL")));
    expect(bills).toHaveLength(1);
    expect(bills[0].idempotencyKey).toBe(key);
  });

  it("no key → old behavior (201, NULL idempotency_key)", async () => {
    const q3 = crypto.randomUUID();
    await routeDb.insert(s.salesDocs).values({
      id: q3, companyId: hoisted.cid, branchId, partyId: customerId,
      docType: "QUOTATION", docNo: "QUO-0003", date: new Date("2026-10-01"),
      status: "POSTED", subtotal: 10000n, grandTotal: 10000n, createdById: hoisted.uid,
    });
    await routeDb.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: q3, productId, description: "Conv widget",
      qty: 1000n, rate: 10000n, discount: 0n, taxBps: 0,
    });
    const r = await salesConvert.POST(
      await reqJson(`http://t/api/sales/${q3}/convert`, {}),
      { params: Promise.resolve({ id: q3 }) }
    );
    expect(r.status).toBe(201);
    const docId = (await r.json()).data.docId;
    const [doc] = await routeDb.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.idempotencyKey).toBeNull();
  });
});
