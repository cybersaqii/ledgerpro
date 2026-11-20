/**
 * Expenses donut regression tests: GET /api/dashboard/overview — the donut
 * total must equal the P&L Total Expenses on the same page, follow the
 * selected period, and ignore voided expenses.
 *
 * Defect (live, 2026-11-04; root-caused Phase 1, 2026-11-20): the donut was
 * built from the `expenses` table (direct cash expenses only, amount + sales
 * tax) while P&L Total Expenses comes from GL sums over every EXPENSE-type
 * account — COGS 5001, Discount Given 5010, FX Loss 6040, bad debts,
 * depreciation, payroll, ... — with tax booked to Input Tax (asset), not
 * expense. The two numbers measured different things, so they could never
 * agree; for a wholesaler the COGS slice alone dwarfs direct expenses.
 *
 * Fix: the donut is now derived from the same glSums map as the P&L
 * (same source, same period) — slices are the top 5 EXPENSE accounts by
 * net debit, total is the full P&L expense total. Voided expenses net to
 * zero through their reversing journal. (The 98e6192 orphan case is moot
 * for GL: an account with journal history cannot be deleted.)
 *
 * Route-level test: DATABASE_URL is pointed at an isolated file DB by
 * ./qa-routes-env (imported first) and requirePermission is mocked.
 * Journals are seeded directly (balanced Dr expense / Cr cash).
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
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
const ALL_TIME = "";

describe("dashboard overview expenses donut equals P&L expenses", () => {
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

    // One custom expense account + the system COGS account (5001) + the
    // cash bank's GL account as the balanced credit side.
    const expAccountId = crypto.randomUUID();
    await routeDb.insert(s.accounts).values({
      id: expAccountId, companyId: hoisted.cid, code: "T-EXP", name: "Test Expenses", type: "EXPENSE",
    });
    const ac = await routeDb.transaction((tx) => accountMap(tx, hoisted.cid));
    const cogsId = ac[SYS.COGS];
    const [cash] = await routeDb
      .select({ accountId: s.bankAccounts.accountId })
      .from(s.bankAccounts)
      .where(eq(s.bankAccounts.companyId, hoisted.cid))
      .limit(1);
    const cashGlId = cash!.accountId;

    const seedJournal = async (opts: { accountId: string; amount: bigint; date: Date; reverse?: boolean }) => {
      const entryId = crypto.randomUUID();
      await routeDb.insert(s.journalEntries).values({
        id: entryId, companyId: hoisted.cid, date: opts.date,
        memo: "donut test journal", source: "MANUAL", createdById: hoisted.uid,
      });
      const dr = opts.reverse ? 0n : opts.amount;
      const cr = opts.reverse ? opts.amount : 0n;
      await routeDb.insert(s.journalLines).values([
        { id: crypto.randomUUID(), entryId, accountId: opts.accountId, debit: dr, credit: cr },
        { id: crypto.randomUUID(), entryId, accountId: cashGlId, debit: cr, credit: dr },
      ]);
    };

    // In-period direct expense: Rs 500.
    await seedJournal({ accountId: expAccountId, amount: 50000n, date: new Date("2026-09-15") });
    // In-period COGS: Rs 1,000 — the old expenses-table donut never saw it.
    await seedJournal({ accountId: cogsId, amount: 100000n, date: new Date("2026-09-16") });
    // In-period expense + its void (reversing journal): Rs 2,000 nets to 0.
    await seedJournal({ accountId: expAccountId, amount: 200000n, date: new Date("2026-09-17") });
    await seedJournal({ accountId: expAccountId, amount: 200000n, date: new Date("2026-09-18"), reverse: true });
    // Out of period (previous FY): Rs 3,000 — excluded only when a period is sent.
    await seedJournal({ accountId: expAccountId, amount: 300000n, date: new Date("2025-06-15") });
  }, 90000);

  it("donut total equals P&L Total Expenses and includes COGS", async () => {
    const d = await getOverview(FY);
    // Total = Rs 500 direct + Rs 1,000 COGS = 150000 paisa.
    expect(Number(d.expenses.total)).toBe(150000);
    expect(Number(d.pnl.expenses)).toBe(150000);
    expect(d.expenses.top).toHaveLength(2);
    const linked = d.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(linked).toBeDefined();
    expect(Number(linked.total)).toBe(50000);
    const cogs = d.expenses.top.find((c: { name: string }) => c.name === "Cost of Goods Sold");
    expect(cogs).toBeDefined();
    expect(Number(cogs.total)).toBe(100000);
    // Donut slices sum to the total — total and donut agree.
    const donutSum = d.expenses.top.reduce((sum: number, c: { total: string }) => sum + Number(c.total), 0);
    expect(donutSum).toBe(Number(d.expenses.total));
  });

  it("voided expense is excluded from both total and donut", async () => {
    const d = await getOverview(FY);
    expect(Number(d.expenses.total)).toBe(150000);
    expect(Number(d.pnl.expenses)).toBe(150000);
    // The Rs 2,000 voided expense would push the linked total to 250000.
    const linked = d.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(Number(linked.total)).toBe(50000);
  });

  it("expense outside the selected period is excluded from both total and donut", async () => {
    const inPeriod = await getOverview(FY);
    expect(Number(inPeriod.expenses.total)).toBe(150000);
    expect(Number(inPeriod.pnl.expenses)).toBe(150000);
    // Without any period the same endpoint is all-time: the Rs 3,000
    // out-of-period expense joins the linked category.
    const allTime = await getOverview(ALL_TIME);
    expect(Number(allTime.expenses.total)).toBe(450000);
    expect(Number(allTime.pnl.expenses)).toBe(450000);
    const linked = allTime.expenses.top.find((c: { name: string }) => c.name === "Test Expenses");
    expect(Number(linked.total)).toBe(350000);
  });
});
