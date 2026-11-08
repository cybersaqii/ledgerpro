/**
 * Stage 2 (video spec) route tests: GET /api/dashboard/overview now also
 * returns aging doc counts, the bank account number, monthly sales, and the
 * 12-month bank cash-flow / month-end balance series used by the Business
 * Overview charts. Series come from the double-entry ledger (bank GL
 * accounts' journal lines); the month-end balance series is anchored so its
 * last point equals the cached bank total.
 *
 * Route-level test: DATABASE_URL is pointed at an isolated file DB by
 * ./qa-routes-env (imported first) and requirePermission is mocked.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq } from "drizzle-orm";
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
let overview: typeof import("@/app/api/dashboard/overview/route");

async function getOverview() {
  const { NextRequest } = await import("next/server");
  const r = await overview.GET(
    new NextRequest("http://t/api/dashboard/overview?salesFrom=2026-07-01&salesTo=2027-06-30")
  );
  expect(r.status).toBe(200);
  return (await r.json()).data;
}

describe("dashboard overview monthly series", () => {
  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    overview = await import("@/app/api/dashboard/overview/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Overview Co", businessType: "WHOLESALE" });
    await setupCompany(routeDb, hoisted.cid);
    await routeDb.insert(s.users).values({
      id: hoisted.uid, companyId: hoisted.cid, name: "Owner", email: "owner@test.co",
      passwordHash: "x", role: "OWNER",
    });

    const glAccounts = await routeDb
      .select({ id: s.accounts.id, type: s.accounts.type })
      .from(s.accounts)
      .where(eq(s.accounts.companyId, hoisted.cid));
    const bankGl = glAccounts.find((a) => a.type === "ASSET")!;
    const otherGl = glAccounts.find((a) => a.id !== bankGl.id)!;

    // One bank account (cached balance Rs 5,000) linked to a GL account.
    await routeDb.insert(s.bankAccounts).values({
      id: crypto.randomUUID(), companyId: hoisted.cid, name: "Test Bank",
      accountNo: "123456", kind: "BANK", accountId: bankGl.id, balance: 500000n,
    });

    const now = Date.now();
    const postEntry = async (lines: Array<{ accountId: string; debit?: bigint; credit?: bigint }>) => {
      const entryId = crypto.randomUUID();
      await routeDb.insert(s.journalEntries).values({
        id: entryId, companyId: hoisted.cid, date: new Date(now), memo: "qa",
        source: "MANUAL", createdById: hoisted.uid,
      });
      for (const l of lines) {
        await routeDb.insert(s.journalLines).values({
          id: crypto.randomUUID(), entryId, accountId: l.accountId,
          debit: l.debit ?? 0n, credit: l.credit ?? 0n,
        });
      }
    };
    // Money in this month: Rs 2,000 into the bank. Money out: Rs 500.
    await postEntry([
      { accountId: bankGl.id, debit: 200000n },
      { accountId: otherGl.id, credit: 200000n },
    ]);
    await postEntry([
      { accountId: otherGl.id, debit: 50000n },
      { accountId: bankGl.id, credit: 50000n },
    ]);

    // One unpaid invoice (Rs 1,000), due today → "Current" bucket, count 1.
    const partyId = crypto.randomUUID();
    await routeDb.insert(s.parties).values({
      id: partyId, companyId: hoisted.cid, kind: "CUSTOMER", name: "Test Customer", balance: 100000n,
    });
    await routeDb.insert(s.salesDocs).values({
      companyId: hoisted.cid, branchId: "main", partyId,
      docType: "INVOICE", docNo: "INV-0001", date: new Date(now), dueDate: new Date(now),
      status: "POSTED", grandTotal: 100000n, amountPaid: 0n, createdById: hoisted.uid,
    });
  }, 90000);

  it("returns aging totals + doc counts and the bank account number", async () => {
    const d = await getOverview();
    expect(d.ar.total).toBe("100000");
    expect(d.ar.counts.current).toBe(1);
    expect(d.ar.buckets.current).toBe("100000");
    // setupCompany seeds its own default bank account; find the one we added.
    const testBank = d.banks.find((b: { name: string }) => b.name === "Test Bank");
    expect(testBank).toBeDefined();
    expect(testBank.code).toBe("123456");
    expect(testBank.balance).toBe("500000");
  });

  it("returns 12 monthly sales points for the FY period", async () => {
    const d = await getOverview();
    expect(d.sales.monthly).toHaveLength(12);
    expect(d.sales.monthly[0].label).toBe("Jul-26");
    // The seeded invoice is dated "now" (Nov 2026) → its month holds Rs 1,000.
    const nov = d.sales.monthly.find((m: { label: string }) => m.label === "Nov-26");
    expect(nov?.total).toBe(1000);
    expect(Number(d.sales.total)).toBe(100000);
  });

  it("returns the 12-month cash flow from bank journal lines", async () => {
    const d = await getOverview();
    expect(d.cashFlow).toHaveLength(12);
    const current = d.cashFlow[11];
    expect(current.in).toBe(2000);
    expect(current.out).toBe(500);
    expect(d.cashFlow.slice(0, 11).every((m: { in: number; out: number }) => m.in === 0 && m.out === 0)).toBe(true);
  });

  it("anchors the month-end bank balance series to the cached total", async () => {
    const d = await getOverview();
    expect(d.bankMonthly).toHaveLength(12);
    // Last point = cached bank total (Rs 5,000); earlier months are flat
    // because the only movements happened this month.
    expect(d.bankMonthly[11].balance).toBe(5000);
    expect(d.bankMonthly[10].balance).toBe(3500);
  });
});
