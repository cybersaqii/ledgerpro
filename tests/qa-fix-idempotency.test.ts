/**
 * QA-FIX regression tests: idempotency keys + rate limits on money-moving
 * creates (migration 0031, lib/idempotency.ts).
 *
 * Route-level tests import the real Next route handlers. Like
 * tests/qa-backend-fixes.test.ts, DATABASE_URL is pointed at an isolated
 * file DB by ./qa-routes-env (imported first) before any lib module
 * evaluates the db singleton, and requirePermission/requirePro are mocked.
 *
 * Covers:
 *  (a) POST /api/sales twice with the same key → exactly 1 doc, second
 *      response is 200 (replay) with the same doc id;
 *  (b) different keys → 2 docs;
 *  (c) no key → old behavior (201, NULL idempotency_key);
 *  (d) the 60/min per-user+company throttle trips after a burst (429 +
 *      Retry-After), tested last so it can't starve the other tests;
 *  (e) over-long key → 422;
 *  plus: purchases / payments / POS checkout / transfers replay, the
 *  X-Idempotency-Key header path, migration 0031 artifacts, and the
 *  isIdempotencyConflict classifier.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompany } from "@/lib/setup";
import {
  extractIdempotencyKey,
  isIdempotencyConflict,
  IDEMPOTENCY_KEY_MAX_LENGTH,
  MONEY_CREATE_LIMIT,
} from "@/lib/idempotency";
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

vi.mock("@/lib/billing-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing-guards")>();
  return {
    ...actual,
    requirePro: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Tester" },
      companyId: hoisted.cid,
      billing: null,
      response: null,
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
let salesRoute: typeof import("@/app/api/sales/route");
let purchasesRoute: typeof import("@/app/api/purchases/route");
let paymentsRoute: typeof import("@/app/api/payments/route");
let expensesRoute: typeof import("@/app/api/expenses/route");
let transfersRoute: typeof import("@/app/api/transfers/route");
let checkoutRoute: typeof import("@/app/api/pos/checkout/route");

let customerId = "";
let supplierId = "";
let productId = "";
let cashBankId = "";
let bank2Id = "";
let expenseAccountId = "";

async function reqJson(url: string, body: unknown, headers?: Record<string, string>) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

function saleBody(key?: string) {
  return {
    docType: "INVOICE",
    partyId: customerId,
    date: "2026-09-30",
    items: [{ description: "Idem widget", qty: "1", rate: "100" }],
    ...(key ? { idempotencyKey: key } : {}),
  };
}

describe("idempotency keys + money-create rate limits", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    salesRoute = await import("@/app/api/sales/route");
    purchasesRoute = await import("@/app/api/purchases/route");
    paymentsRoute = await import("@/app/api/payments/route");
    expensesRoute = await import("@/app/api/expenses/route");
    transfersRoute = await import("@/app/api/transfers/route");
    checkoutRoute = await import("@/app/api/pos/checkout/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Idem Co", businessType: "WHOLESALE" });
    await setupCompany(routeDb, hoisted.cid);
    customerId = crypto.randomUUID();
    supplierId = crypto.randomUUID();
    await routeDb.insert(s.parties).values([
      { id: customerId, companyId: hoisted.cid, name: "IC", kind: "CUSTOMER", balance: 0n },
      { id: supplierId, companyId: hoisted.cid, name: "IS", kind: "SUPPLIER", balance: 0n },
    ]);
    productId = crypto.randomUUID();
    await routeDb.insert(s.products).values({
      id: productId, companyId: hoisted.cid, sku: "IDEM-1", name: "Idem widget", trackStock: false,
    });
    cashBankId = (
      await routeDb
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, hoisted.cid), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0].id;
    // Second bank account for transfers.
    const glId = crypto.randomUUID();
    await routeDb.insert(s.accounts).values({
      id: glId, companyId: hoisted.cid, code: "1011", name: "Test Bank GL", type: "ASSET", isSystem: true,
    });
    bank2Id = crypto.randomUUID();
    await routeDb.insert(s.bankAccounts).values({
      id: bank2Id, companyId: hoisted.cid, name: "Test Bank", kind: "BANK", accountId: glId, balance: 0n,
    });
    expenseAccountId = (
      await routeDb
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.companyId, hoisted.cid), eq(s.accounts.code, "6000")))
        .limit(1)
    )[0].id;
  }, 90000);

  it("migration 0031 applied: idempotency_key columns + partial unique indexes", async () => {
    const mig = await routeDb.run(
      sql`SELECT version FROM schema_migrations WHERE version = '0031_idempotency_keys'`
    );
    expect(mig.rows.length).toBe(1);
    const cols = await routeDb.run(sql`PRAGMA table_info(sales_docs)`);
    const names = (cols.rows as unknown as { name: string }[]).map((r) => r.name);
    expect(names).toContain("idempotency_key");
    const idx = await routeDb.run(
      sql`SELECT name, sql FROM sqlite_master WHERE type='index' AND name LIKE '%idem_key'`
    );
    const idxNames = (idx.rows as unknown as { name: string; sql: string }[]).map((r) => r.name).sort();
    expect(idxNames).toEqual([
      "bank_adjustments_idem_key", // Module 3
      "expenses_idem_key",
      "parties_idem_key",
      "payments_idem_key",
      "purchase_docs_idem_key",
      "sales_docs_idem_key",
      "sundry_receipts_idem_key", // Module 3
      "transfers_idem_key",
      "write_offs_idem_key",
    ]);
    for (const r of idx.rows as unknown as { sql: string }[]) {
      expect(r.sql).toContain("UNIQUE");
      expect(r.sql).toContain("WHERE idempotency_key IS NOT NULL");
    }
  });

  it("(a) POST /api/sales twice with the same key → exactly 1 doc, second is a 200 replay", async () => {
    const key = crypto.randomUUID();
    const r1 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody(key)));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    const r2 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody(key)));
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()).data;
    expect(d2.docId).toBe(d1.docId);
    expect(d2.idempotentReplay).toBe(true);
    const n = await routeDb
      .select({ n: sql<number>`count(*)` })
      .from(s.salesDocs)
      .where(and(eq(s.salesDocs.companyId, hoisted.cid), eq(s.salesDocs.idempotencyKey, key)));
    expect(n[0]?.n ?? 0).toBe(1);
  });

  it("(b) different keys → 2 docs", async () => {
    const before = (
      await routeDb
        .select({ n: sql<number>`count(*)` })
        .from(s.salesDocs)
        .where(eq(s.salesDocs.companyId, hoisted.cid))
    )[0]?.n ?? 0;
    const r1 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody(crypto.randomUUID())));
    const r2 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody(crypto.randomUUID())));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const after = (
      await routeDb
        .select({ n: sql<number>`count(*)` })
        .from(s.salesDocs)
        .where(eq(s.salesDocs.companyId, hoisted.cid))
    )[0]?.n ?? 0;
    expect(after - before).toBe(2);
    expect((await r1.json()).data.docId).not.toBe((await r2.json()).data.docId);
  });

  it("(c) no key → old behavior: 201 and NULL idempotency_key", async () => {
    const r1 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody()));
    const r2 = await salesRoute.POST(await reqJson("http://x/api/sales", saleBody()));
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    const d1 = (await r1.json()).data;
    const rows = await routeDb
      .select({ k: s.salesDocs.idempotencyKey })
      .from(s.salesDocs)
      .where(eq(s.salesDocs.id, d1.docId))
      .limit(1);
    expect(rows[0]?.k).toBeNull();
  });

  it("POST /api/purchases twice with the same key → 1 bill", async () => {
    const key = crypto.randomUUID();
    const body = {
      docType: "BILL",
      partyId: supplierId,
      date: "2026-09-30",
      refNo: "IDEM-1", // Module 2: vendor bill reference is compulsory on bills
      items: [{ description: "Idem stock", qty: "2", rate: "50" }],
      idempotencyKey: key,
    };
    const r1 = await purchasesRoute.POST(await reqJson("http://x/api/purchases", body));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    const r2 = await purchasesRoute.POST(await reqJson("http://x/api/purchases", body));
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.docId).toBe(d1.docId);
    const n = await routeDb
      .select({ n: sql<number>`count(*)` })
      .from(s.purchaseDocs)
      .where(and(eq(s.purchaseDocs.companyId, hoisted.cid), eq(s.purchaseDocs.idempotencyKey, key)));
    expect(n[0]?.n ?? 0).toBe(1);
  });

  it("POST /api/payments twice with the same key → 1 payment", async () => {
    const key = crypto.randomUUID();
    const body = {
      kind: "RECEIPT",
      partyId: customerId,
      bankAccountId: cashBankId,
      date: "2026-09-30",
      amount: "250",
      idempotencyKey: key,
    };
    const r1 = await paymentsRoute.POST(await reqJson("http://x/api/payments", body));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    const r2 = await paymentsRoute.POST(await reqJson("http://x/api/payments", body));
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()).data;
    expect(d2.id).toBe(d1.id);
    expect(d2.idempotentReplay).toBe(true);
    const n = await routeDb
      .select({ n: sql<number>`count(*)` })
      .from(s.payments)
      .where(and(eq(s.payments.companyId, hoisted.cid), eq(s.payments.idempotencyKey, key)));
    expect(n[0]?.n ?? 0).toBe(1);
  });

  it("POST /api/pos/checkout twice with the same key → 1 invoice", async () => {
    const key = crypto.randomUUID();
    const body = {
      partyId: customerId,
      date: "2026-09-30",
      items: [{ productId, description: "Idem widget", qty: "1", rate: "100" }],
      payments: [],
      idempotencyKey: key,
    };
    const r1 = await checkoutRoute.POST(await reqJson("http://x/api/pos/checkout", body));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    const r2 = await checkoutRoute.POST(await reqJson("http://x/api/pos/checkout", body));
    expect(r2.status).toBe(200);
    const d2 = (await r2.json()).data;
    expect(d2.docId).toBe(d1.docId);
    expect(d2.idempotentReplay).toBe(true);
    const n = await routeDb
      .select({ n: sql<number>`count(*)` })
      .from(s.salesDocs)
      .where(and(eq(s.salesDocs.companyId, hoisted.cid), eq(s.salesDocs.idempotencyKey, key)));
    expect(n[0]?.n ?? 0).toBe(1);
  });

  it("X-Idempotency-Key header is honored (POST /api/transfers)", async () => {
    const key = crypto.randomUUID();
    const body = {
      fromBankAccountId: cashBankId,
      toBankAccountId: bank2Id,
      date: "2026-09-30",
      amount: "75",
    };
    const r1 = await transfersRoute.POST(await reqJson("http://x/api/transfers", body, { "x-idempotency-key": key }));
    expect(r1.status).toBe(201);
    const d1 = (await r1.json()).data;
    const r2 = await transfersRoute.POST(await reqJson("http://x/api/transfers", body, { "x-idempotency-key": key }));
    expect(r2.status).toBe(200);
    expect((await r2.json()).data.id).toBe(d1.id);
    const n = await routeDb
      .select({ n: sql<number>`count(*)` })
      .from(s.transfers)
      .where(and(eq(s.transfers.companyId, hoisted.cid), eq(s.transfers.idempotencyKey, key)));
    expect(n[0]?.n ?? 0).toBe(1);
  });

  it("(e) over-long idempotency key → 422", async () => {
    const long = "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1);
    const body = {
      accountId: expenseAccountId,
      bankAccountId: cashBankId,
      date: "2026-09-30",
      amount: "10",
      idempotencyKey: long,
    };
    const r1 = await expensesRoute.POST(await reqJson("http://x/api/expenses", body));
    expect(r1.status).toBe(422);
    const r2 = await expensesRoute.POST(
      await reqJson(
        "http://x/api/expenses",
        { accountId: expenseAccountId, bankAccountId: cashBankId, date: "2026-09-30", amount: "10" },
        { "x-idempotency-key": long }
      )
    );
    expect(r2.status).toBe(422);
    // exactly-64-char keys are accepted
    const okKey = "k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH);
    const r3 = await expensesRoute.POST(
      await reqJson("http://x/api/expenses", {
        accountId: expenseAccountId, bankAccountId: cashBankId, date: "2026-09-30", amount: "10", idempotencyKey: okKey,
      })
    );
    expect(r3.status).toBe(201);
  });

  it("extractIdempotencyKey prefers the header and rejects non-strings", async () => {
    const { NextRequest } = await import("next/server");
    const req = new NextRequest("http://x/api/sales", { headers: { "x-idempotency-key": " hdr-key " } });
    expect(extractIdempotencyKey(req, { idempotencyKey: "body-key" })).toBe("hdr-key");
    const req2 = new NextRequest("http://x/api/sales");
    expect(extractIdempotencyKey(req2, { idempotencyKey: " body-key " })).toBe("body-key");
    expect(extractIdempotencyKey(req2, {})).toBeUndefined();
    expect(() => extractIdempotencyKey(req2, { idempotencyKey: 42 as unknown as string })).not.toThrow();
  });

  it("isIdempotencyConflict classifies unique-violation errors", () => {
    const conflict = new Error(
      "Failed query: insert into `payments` ... UNIQUE constraint failed: payments.company_id, payments.idempotency_key"
    );
    (conflict as unknown as { cause: Error }).cause = new Error(
      "UNIQUE constraint failed: payments.company_id, payments.idempotency_key"
    );
    expect(isIdempotencyConflict(conflict)).toBe(true);
    expect(isIdempotencyConflict(new Error("UNIQUE constraint failed: sales_docs.company_id, sales_docs.doc_no"))).toBe(false);
    expect(isIdempotencyConflict(new Error("connection reset"))).toBe(false);
    expect(isIdempotencyConflict(null)).toBe(false);
  });

  // NOTE: the rate-limit burst test runs LAST — it consumes the whole
  // per-route quota for this (user, company).
  it("(d) rate limit trips after a burst of money creates", async () => {
    // Reset this route's throttle bucket (the 422 test above never consumed
    // quota, but the exactly-64-char success case did) so the burst is exact.
    await routeDb.run(
      sql`DELETE FROM rate_limits WHERE key = ${`money-create:expenses:${hoisted.cid}:${hoisted.uid}`}`
    );
    const mk = (i: number) =>
      reqJson("http://x/api/expenses", {
        accountId: expenseAccountId,
        bankAccountId: cashBankId,
        date: "2026-09-30",
        amount: "1",
        idempotencyKey: `rl-burst-${i}-${crypto.randomUUID()}`,
      });
    let limited = 0;
    for (let i = 0; i < MONEY_CREATE_LIMIT + 1; i++) {
      const res = await expensesRoute.POST(await mk(i));
      if (res.status === 429) {
        limited++;
        expect(res.headers.get("Retry-After")).toBeTruthy();
        expect((await res.json()).code).toBe("RATE_LIMITED");
      } else {
        expect(res.status).toBe(201);
      }
    }
    // The 61st request (limit is 60/min) is the one that gets throttled.
    expect(limited).toBe(1);
  }, 120000);
});
