/**
 * QA-sweep 2026-10-25 regression test: signup atomicity (backend-report
 * L4 — the company row was inserted outside the user+link transaction,
 * so a crash between the two could leave an ownerless company row).
 *
 * Route-level test importing the real POST /api/auth/signup handler.
 * Like tests/qa-fix-idempotency.test.ts, DATABASE_URL is pointed at an
 * isolated file DB by ./qa-routes-env (imported first). next/headers
 * cookies, the signup rate limiter, and the welcome email are mocked;
 * setupCompany runs for real so the full happy path is exercised.
 *
 * Covers: a fresh signup creates the company row, the OWNER user row, and
 * the ACTIVE user_companies link together, and answers ok.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as s from "@/db/schema";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
    set: () => {},
    delete: () => {},
  }),
}));

vi.mock("@/lib/rate-limit-db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit-db")>();
  return {
    ...actual,
    rateLimitDb: async () => ({ ok: true, retryAfterSec: 0 }),
    clientIp: () => "127.0.0.1",
  };
});

vi.mock("@/lib/email", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email")>();
  return { ...actual, sendEmail: async () => {} };
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
let signupRoute: typeof import("@/app/api/auth/signup/route");

beforeAll(async () => {
  await migrateFileDb(ROUTES_DB_URL);
  const dbm = await import("@/lib/db");
  routeDb = dbm.db;
  signupRoute = await import("@/app/api/auth/signup/route");
});

describe("POST /api/auth/signup atomic account creation", () => {
  it("creates company + owner user + active link together", async () => {
    const { NextRequest } = await import("next/server");
    const res = await signupRoute.POST(
      new NextRequest("http://t/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          companyName: "Atomic Co",
          name: "Atomic Owner",
          email: "atomic@qa.test",
          password: "password123",
          businessType: "WHOLESALE",
          termsConsent: true,
        }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; user: { id: string } };
    expect(body.ok).toBe(true);

    const [user] = await routeDb
      .select()
      .from(s.users)
      .where(eq(s.users.email, "atomic@qa.test"))
      .limit(1);
    expect(user).toBeDefined();
    expect(user.role).toBe("OWNER");
    const [company] = await routeDb
      .select()
      .from(s.companies)
      .where(eq(s.companies.id, user.companyId))
      .limit(1);
    expect(company).toBeDefined();
    expect(company.name).toBe("Atomic Co");
    const [link] = await routeDb
      .select()
      .from(s.userCompanies)
      .where(eq(s.userCompanies.userId, user.id))
      .limit(1);
    expect(link).toBeDefined();
    expect(link.companyId).toBe(user.companyId);
    expect(link.isActive).toBe(true);
    expect(link.role).toBe("OWNER");
  });
});
