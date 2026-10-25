/**
 * QA-sweep 2026-10-25 regression tests: per-company staff membership
 * (backend-report §4c / L1 — user_companies.is_active had no writer).
 *
 * Route-level tests import the real Next route handlers. Like
 * tests/qa-fix-idempotency.test.ts, DATABASE_URL is pointed at an isolated
 * file DB by ./qa-routes-env (imported first) before any lib module
 * evaluates the db singleton, and requirePermission/requireOwner/requirePro
 * are mocked.
 *
 * Covers:
 *  (a) PATCH isActive=false (global deactivate) also flips the membership
 *      row for this company — the flag getSession() honours;
 *  (b) PATCH isActive=true flips both back;
 *  (c) PATCH companyActive=false removes the member from THIS company only:
 *      membership row inactive, global users row untouched, and the member
 *      vanishes from GET /api/users (which lists active links only);
 *  (d) POST /api/users with a removed member's email re-adds them (same
 *      user id, fresh link active) instead of 409;
 *  (e) POST with an already-active member's email still 409s.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
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
    session: { uid: hoisted.uid, name: "QA Owner" },
    companyId: hoisted.cid,
  };
  return {
    ...actual,
    db: dbm.db,
    requirePermission: async () => gate,
    requireOwner: async () => gate,
    requireCompany: async () => ({ ...gate, response: null }),
  };
});

vi.mock("@/lib/billing-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing-guards")>();
  return {
    ...actual,
    requirePro: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Owner" },
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
let patchRoute: typeof import("@/app/api/users/[id]/route");
let usersRoute: typeof import("@/app/api/users/route");

const ownerId = hoisted.uid;
const staffId = crypto.randomUUID();
const companyId = hoisted.cid;

async function reqJson(url: string, body: unknown, method = "POST") {
  const { NextRequest } = await import("next/server");
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function linkActive(userId: string): Promise<boolean | null> {
  const [row] = await routeDb
    .select({ isActive: s.userCompanies.isActive })
    .from(s.userCompanies)
    .where(and(eq(s.userCompanies.userId, userId), eq(s.userCompanies.companyId, companyId)))
    .limit(1);
  return row ? row.isActive : null;
}

async function userActive(userId: string): Promise<boolean | null> {
  const [row] = await routeDb
    .select({ isActive: s.users.isActive })
    .from(s.users)
    .where(eq(s.users.id, userId))
    .limit(1);
  return row ? row.isActive : null;
}

beforeAll(async () => {
  await migrateFileDb(ROUTES_DB_URL);
  const dbm = await import("@/lib/db");
  routeDb = dbm.db;
  patchRoute = await import("@/app/api/users/[id]/route");
  usersRoute = await import("@/app/api/users/route");

  await routeDb.insert(s.companies).values({ id: companyId, name: "QA Co" });
  await routeDb.insert(s.users).values([
    { id: ownerId, companyId, name: "QA Owner", email: "owner@qa.test", passwordHash: "x", role: "OWNER", isActive: true },
    { id: staffId, companyId, name: "QA Staff", email: "staff@qa.test", passwordHash: "x", role: "STAFF", isActive: true },
  ]);
  await routeDb.insert(s.userCompanies).values([
    { id: crypto.randomUUID(), userId: ownerId, companyId, role: "OWNER", isActive: true },
    { id: crypto.randomUUID(), userId: staffId, companyId, role: "STAFF", isActive: true },
  ]);
});

describe("PATCH /api/users/[id] membership writes", () => {
  it("(a) global deactivate flips users row AND membership row", async () => {
    const res = await patchRoute.PATCH(
      await reqJson(`http://t/api/users/${staffId}`, { isActive: false }, "PATCH"),
      { params: Promise.resolve({ id: staffId }) }
    );
    expect(res.status).toBe(200);
    expect(await userActive(staffId)).toBe(false);
    expect(await linkActive(staffId)).toBe(false);
  });

  it("(b) global activate flips both back", async () => {
    const res = await patchRoute.PATCH(
      await reqJson(`http://t/api/users/${staffId}`, { isActive: true }, "PATCH"),
      { params: Promise.resolve({ id: staffId }) }
    );
    expect(res.status).toBe(200);
    expect(await userActive(staffId)).toBe(true);
    expect(await linkActive(staffId)).toBe(true);
  });

  it("(c) companyActive=false removes from this company only", async () => {
    const res = await patchRoute.PATCH(
      await reqJson(`http://t/api/users/${staffId}`, { companyActive: false }, "PATCH"),
      { params: Promise.resolve({ id: staffId }) }
    );
    expect(res.status).toBe(200);
    expect(await userActive(staffId)).toBe(true);
    expect(await linkActive(staffId)).toBe(false);
    const list = await usersRoute.GET();
    const body = (await list.json()) as { data: { id: string }[] };
    expect(body.data.map((u) => u.id)).not.toContain(staffId);
  });

  it("(d) re-adding a removed member by email works (no 409)", async () => {
    const res = await usersRoute.POST(
      await reqJson("http://t/api/users", {
        name: "QA Staff",
        email: "staff@qa.test",
        password: "newpassword1",
      })
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { data: { id: string } };
    expect(body.data.id).toBe(staffId);
    expect(await linkActive(staffId)).toBe(true);
  });

  it("(e) adding an already-active member's email still 409s", async () => {
    const res = await usersRoute.POST(
      await reqJson("http://t/api/users", {
        name: "QA Staff",
        email: "staff@qa.test",
        password: "newpassword1",
      })
    );
    expect(res.status).toBe(409);
  });
});
