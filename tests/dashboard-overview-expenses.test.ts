/**
 * Expenses donut regression tests: GET /api/dashboard/overview — total and
 * donut must agree, follow the selected period, and ignore voided expenses.
 *
 * Defect (live, 2026-11-09): expSum counted all expenses with no account
 * join, while expTop grouped by account with an inner join — an expense
 * whose account row was gone dropped out of the donut but stayed in the
 * total. The route also ignored the selected period (page never sent
 * expFrom/expTo) and counted voided expenses.
 *
 * Route-level test: DATABASE_URL is pointed at an isolated file DB by
 * ./qa-routes-env (imported first) and requirePermission is mocked.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
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

vi.mock("@/lib/billing-guards", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/billing-guards")>();
  return { ...actual };
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
let overview: typeof import("@/app/api/dashboard/overview/route");

async function getOverview(query: string) {
  const { NextRequest } = await import("next/server");
  const r = await overview.GET(new NextRequest(`http://t/api/dashboard/overview${query}`));
  expect(r.status).toBe(200);
  return (await r.json()).data;
}

const FY = "?salesFrom=2026-07-01&salesTo=2027-06-30&expFrom=2026-07-01&expTo=2027-06-30";
const ALL_TIME = "?salesFrom=2026-07-01&salesTo=2027-06-30";

describe("dashboard overview expenses total vs donut", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    overview = await import("@/app/api/dashboard/overview/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Expenses Co", businessType: "WHOLESALE" });
    await setupCompany(routeDb, hoisted.cid);
    await routeDb.insert(s.users).values({
      id: hoisted.uid, companyId: hoisted.cid, name: "Owner", email: "owner@test.co",
      passwordHash: "x", role: "OWNER",
    });

    // One real expense account; the orphaned expense points at a random id
    // with no matching account row.
    const expAccountId = crypto.randomUUID();
    await routeDb.insert(s.accounts).values({
      id: expAccountId, companyId: hoisted.cid, code: "T-EXP", name: "Test Expenses", type: "EXPENSE",
    });
    const orphanAccountId = crypto.randomUUID();

    const seedExpense = async (opts: {
      accountId: string; amount: bigint; date: Date; voidedAt?: Date;
    }) => {
      await routeDb.insert(s.expenses).values({
        companyId: hoisted.cid, branchId: "main", accountId: opts.accountId,
        bankAccountId: crypto.randomUUID(), amount: opts.amount, taxAmount: 0n,
        date: opts.date, createdById: hoisted.uid, voidedAt: opts.voidedAt ?? null,
      });
    };

    // In-period, linked: Rs 500.
    await seedExpense({ accountId: expAccountId, amount: 50000n, date: new Date("2026-09-15") });
    // In-period, orphaned account: Rs 1,000 — must appear as "Other expenses".
    await seedExpense({ accountId: orphanAccountId, amount: 100000n, date: new Date("2026-09-16") });
    // In-period but voided: Rs 2,000 — must be excluded everywhere.
    await seedExpense({
      accountId: expAccountId, amount: 200000n, date: new Date("2026-09-17"),
      voidedAt: new Date("2026-09-18"),
    });
    // Out of period (previous FY): Rs 3,000 — excluded only when a period is sent.
    await seedExpense({ accountId: expAccountId, amount: 300000n, date: new Date("2025-06-15") });
  }, 90000);

  it("orphaned expense appears under 'Other expenses' and is counted in total", async () => {
    const d = await getOverview(FY);
    // Total = Rs 500 linked + Rs 1,000 orphaned = 150000 paisa.
    expect(Number(d.expenses.total)).toBe(150000);
    expect(d.expenses.top).toHaveLength(2);
    const other = d.expenses.top.find((c: { name: string }) => c.name === "Other expenses");
    expect(other).toBeDefined();
    expect(Number(other.total)).toBe(100000);
    const linked = d.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(linked).toBeDefined();
    expect(Number(linked.total)).toBe(50000);
    // Donut sums to the total — total and donut agree.
    const donutSum = d.expenses.top.reduce((sum: number, c: { total: string }) => sum + Number(c.total), 0);
    expect(donutSum).toBe(Number(d.expenses.total));
  });

  it("voided expense is excluded from both total and top", async () => {
    const d = await getOverview(FY);
    expect(Number(d.expenses.total)).toBe(150000);
    expect(d.expenses.top).toHaveLength(2);
    // The Rs 2,000 voided expense would push the linked total to 250000.
    const linked = d.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(Number(linked.total)).toBe(50000);
  });

  it("expense outside the selected period is excluded from both total and top", async () => {
    const inPeriod = await getOverview(FY);
    expect(Number(inPeriod.expenses.total)).toBe(150000);
    // Without expFrom/expTo the same endpoint is all-time: the Rs 3,000
    // out-of-period expense joins the linked category.
    const allTime = await getOverview(ALL_TIME);
    expect(Number(allTime.expenses.total)).toBe(450000);
    const linked = allTime.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(Number(linked.total)).toBe(350000);
  });
});
