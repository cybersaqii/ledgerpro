/**
 * Module 3 — route-level idempotency replay for the two new money-moving
 * POSTs: /api/sundry-receipts and /api/bank-accounts/[id]/adjustments.
 *
 * Same harness as tests/qa-fix-idempotency.test.ts: DATABASE_URL is pointed
 * at an isolated file DB by ./qa-routes-env (imported first) before any lib
 * module evaluates the db singleton, and requirePermission is mocked.
 *
 * Covers: POST twice with the same key → exactly 1 row; the second response
 * is 200 (replay) with the same doc id and idempotentReplay: true.
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
let receiptsRoute: typeof import("@/app/api/sundry-receipts/route");
let adjustmentsRoute: typeof import("@/app/api/bank-accounts/[id]/adjustments/route");
let banksRoute: typeof import("@/app/api/banks/route");

let cashBankId = "";
let incomeAccountId = "";

async function reqJson(url: string, body: unknown) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("module 3 idempotency replay", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    receiptsRoute = await import("@/app/api/sundry-receipts/route");
    adjustmentsRoute = await import("@/app/api/bank-accounts/[id]/adjustments/route");
    banksRoute = await import("@/app/api/banks/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "M3 Idem Co" });
    await setupCompany(routeDb, hoisted.cid);
    cashBankId = (
      await routeDb
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, hoisted.cid), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0].id;
    incomeAccountId = (
      await routeDb
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.companyId, hoisted.cid), eq(s.accounts.code, "4020")))
        .limit(1)
    )[0].id;
  });

  it("replays POST /api/sundry-receipts with the same key instead of double-creating", async () => {
    const key = crypto.randomUUID();
    const body = {
      accountId: incomeAccountId,
      bankAccountId: cashBankId,
      date: "2026-09-30",
      amount: "1234.56",
      notes: "idempotency probe",
      idempotencyKey: key,
    };
    const r1 = await receiptsRoute.POST(await reqJson("http://x/api/sundry-receipts", body));
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await receiptsRoute.POST(await reqJson("http://x/api/sundry-receipts", body));
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.idempotentReplay).toBe(true);
    expect(j2.data.id).toBe(j1.data.id);
    expect(j2.data.docNo).toBe(j1.data.docNo);

    const rows = await routeDb
      .select({ id: s.sundryReceipts.id })
      .from(s.sundryReceipts)
      .where(eq(s.sundryReceipts.companyId, hoisted.cid));
    expect(rows).toHaveLength(1);
  });

  it("replays POST /api/bank-accounts/[id]/adjustments with the same key", async () => {
    const key = crypto.randomUUID();
    const body = { kind: "CHARGE", date: "2026-09-30", amount: "99.99", notes: "idem probe", idempotencyKey: key };
    const url = `http://x/api/bank-accounts/${cashBankId}/adjustments`;
    const ctx = { params: Promise.resolve({ id: cashBankId }) } as unknown as {
      params: Promise<{ id: string }>;
    };

    const r1 = await adjustmentsRoute.POST(await reqJson(url, body), ctx);
    expect(r1.status).toBe(201);
    const j1 = await r1.json();

    const r2 = await adjustmentsRoute.POST(await reqJson(url, body), ctx);
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.idempotentReplay).toBe(true);
    expect(j2.data.id).toBe(j1.data.id);

    const rows = await routeDb
      .select({ id: s.bankAdjustments.id })
      .from(s.bankAdjustments)
      .where(eq(s.bankAdjustments.companyId, hoisted.cid));
    expect(rows).toHaveLength(1);
  });

  it("rejects a negative opening for a non-overdraft account with 422, allows it for OVERDRAFT", async () => {
    const bad = await banksRoute.POST(
      await reqJson("http://x/api/banks", {
        name: "Bad Current " + crypto.randomUUID().slice(0, 8),
        kind: "BANK",
        accountType: "CURRENT",
        openingBalance: "-10",
      })
    );
    expect(bad.status).toBe(422);

    const ok = await banksRoute.POST(
      await reqJson("http://x/api/banks", {
        name: "OD " + crypto.randomUUID().slice(0, 8),
        kind: "BANK",
        accountType: "OVERDRAFT",
        openingBalance: "-10",
      })
    );
    expect(ok.status).toBe(201);
  });
});
