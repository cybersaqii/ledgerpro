/**
 * Sunday sweep 2026-11-08 regression tests: Partner Contribute / Drawing
 * had no idempotency (a double-click / retry posted the capital movement
 * twice) and no period-lock check on the client-supplied date.
 *
 * Route-level tests import the real Next route handlers. Like
 * tests/qa-fix-convert-idempotency.test.ts, DATABASE_URL is pointed at an
 * isolated file DB by ./qa-routes-env (imported first) before any lib module
 * evaluates the db singleton, and requirePermission is mocked.
 *
 * Covers:
 *  (a) POST /api/partners/[id]/contribute twice with the same key → exactly
 *      1 movement, second response is 200 (replay) with the same tx id;
 *  (b) POST /api/partners/[id]/draw twice with the same key → same;
 *  (c) no key → old behavior (201 twice, two movements);
 *  (d) locked period → 422 PERIOD_LOCKED.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompany } from "@/lib/setup";
import { registerPartner } from "@/lib/partners";
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
let contribute: typeof import("@/app/api/partners/[id]/contribute/route");
let draw: typeof import("@/app/api/partners/[id]/draw/route");

let cashAccountId = "";
let partnerId = "";

async function reqJson(url: string, body: unknown, headers?: Record<string, string>) {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(headers || {}) },
    body: JSON.stringify(body),
  });
}

async function movementCount(): Promise<number> {
  const rows = await routeDb
    .select()
    .from(s.partnerTransactions)
    .where(eq(s.partnerTransactions.partnerId, partnerId));
  return rows.length;
}

async function journalCountForKey(key: string): Promise<number> {
  const rows = await routeDb
    .select()
    .from(s.journalEntries)
    .where(
      and(eq(s.journalEntries.companyId, hoisted.cid), eq(s.journalEntries.idempotencyKey, key))
    );
  return rows.length;
}

describe("partner contribute/draw idempotency + period lock", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    contribute = await import("@/app/api/partners/[id]/contribute/route");
    draw = await import("@/app/api/partners/[id]/draw/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Partner Co", businessType: "WHOLESALE" });
    await setupCompany(routeDb, hoisted.cid);
    await routeDb.insert(s.users).values({
      id: hoisted.uid, companyId: hoisted.cid, name: "Owner", email: "owner@test.co",
      passwordHash: "x", role: "OWNER",
    });
    cashAccountId = (
      await routeDb
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(eq(s.accounts.companyId, hoisted.cid))
        .limit(1)
    )[0].id;
    const p = await routeDb.transaction((tx) =>
      registerPartner(tx, {
        companyId: hoisted.cid,
        name: "Ahmed",
        profitShareBps: 6000,
        createdById: hoisted.uid,
      })
    );
    partnerId = p.id;
  }, 90000);

  it("contribute replays on the same key", async () => {
    const key = "partner-contrib-1";
    const body = { amount: "1000.00", accountId: cashAccountId, date: "2026-11-08", idempotencyKey: key };
    const r1 = await contribute.POST(await reqJson(`http://t/api/partners/${partnerId}/contribute`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await contribute.POST(await reqJson(`http://t/api/partners/${partnerId}/contribute`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.id).toBe(j1.data.id);
    expect(j2.data.idempotentReplay).toBe(true);
    expect(await movementCount()).toBe(1);
    expect(await journalCountForKey(key)).toBe(1);
  });

  it("draw replays on the same key", async () => {
    const key = "partner-draw-1";
    const body = { amount: "500.00", accountId: cashAccountId, date: "2026-11-08", idempotencyKey: key };
    const r1 = await draw.POST(await reqJson(`http://t/api/partners/${partnerId}/draw`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r1.status).toBe(201);
    const j1 = await r1.json();
    const r2 = await draw.POST(await reqJson(`http://t/api/partners/${partnerId}/draw`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r2.status).toBe(200);
    const j2 = await r2.json();
    expect(j2.data.id).toBe(j1.data.id);
    expect(j2.data.idempotentReplay).toBe(true);
    expect(await movementCount()).toBe(2);
    expect(await journalCountForKey(key)).toBe(1);
  });

  it("no key → old behavior (two separate movements)", async () => {
    const body = { amount: "100.00", accountId: cashAccountId, date: "2026-11-08" };
    const r1 = await contribute.POST(await reqJson(`http://t/api/partners/${partnerId}/contribute`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r1.status).toBe(201);
    const r2 = await contribute.POST(await reqJson(`http://t/api/partners/${partnerId}/contribute`, body), {
      params: Promise.resolve({ id: partnerId }),
    });
    expect(r2.status).toBe(201);
    expect(await movementCount()).toBe(4);
  });

  it("locked period rejects the movement", async () => {
    await routeDb
      .update(s.companies)
      .set({ lockedUntil: new Date("2026-12-31") })
      .where(eq(s.companies.id, hoisted.cid));
    try {
      const r = await contribute.POST(
        await reqJson(`http://t/api/partners/${partnerId}/contribute`, {
          amount: "100.00", accountId: cashAccountId, date: "2026-11-08",
        }),
        { params: Promise.resolve({ id: partnerId }) }
      );
      expect(r.status).toBe(422);
      const j = await r.json();
      expect(j.code).toBe("PERIOD_LOCKED");
      expect(await movementCount()).toBe(4);
    } finally {
      await routeDb
        .update(s.companies)
        .set({ lockedUntil: null })
        .where(eq(s.companies.id, hoisted.cid));
    }
  });
});
