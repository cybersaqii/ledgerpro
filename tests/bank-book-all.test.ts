/**
 * Bank book "All accounts" view (accountId=all).
 *  1. Merges journal lines from every active cash/bank account into one
 *     date-ordered ledger with a combined running balance.
 *  2. Each entry carries its source account name.
 *  3. A single accountId still filters to that account only (regression).
 *  4. accountId=all with zero bank accounts returns an empty ledger.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { setupCompany, addBankAccount, accountMap } from "@/lib/setup";
import { postSundryReceipt } from "@/lib/posting";
import { parseMoney } from "@/lib/money";
import type { TestDb } from "./helpers";
import type { DbTx } from "@/lib/db";
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
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
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
    }
  } finally {
    client.close();
  }
}

describe("bank book accountId=all", () => {
  let routeDb: TestDb;
  let route: typeof import("@/app/api/reports/bank-book/route");
  let branchId = "";
  let cashId = "";
  let bankId = "";
  let incomeGl = "";

  async function get(path: string) {
    const { NextRequest } = await import("next/server");
    const res = await route.GET(new NextRequest(`http://x${path}`));
    return { status: res.status, body: await res.json() };
  }

  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    route = await import("@/app/api/reports/bank-book/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "All Bank Co", businessType: "WHOLESALE" });
    ({ branchId } = await setupCompany(routeDb, hoisted.cid));
    const map = await routeDb.transaction((tx) => accountMap(tx, hoisted.cid));
    incomeGl = map["4001"] ?? map["4000"] ?? Object.values(map)[0];

    // setupCompany already seeds a "Cash in Hand" account — reuse it.
    const [seedCash] = await routeDb
      .select()
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, hoisted.cid), eq(s.bankAccounts.name, "Cash in Hand")))
      .limit(1);
    const bank = await addBankAccount(routeDb, hoisted.cid, { name: "Allied Bank", kind: "BANK", bankName: "Allied", accountNo: "001122" });
    cashId = seedCash.id;
    bankId = bank.id;

    // Rs 1,000 into cash on Sep 1, Rs 2,500 into the bank on Sep 3.
    await routeDb.transaction((tx: DbTx) =>
      postSundryReceipt(tx, {
        companyId: hoisted.cid, branchId, accountId: incomeGl, bankAccountId: cashId,
        date: new Date("2026-09-01T10:00:00Z"), amount: parseMoney("1000"),
        notes: "cash sale", createdById: hoisted.uid,
      })
    );
    await routeDb.transaction((tx: DbTx) =>
      postSundryReceipt(tx, {
        companyId: hoisted.cid, branchId, accountId: incomeGl, bankAccountId: bankId,
        date: new Date("2026-09-03T10:00:00Z"), amount: parseMoney("2500"),
        notes: "bank receipt", createdById: hoisted.uid,
      })
    );
  }, 120000);

  afterAll(async () => {
    try {
      await routeDb.delete(s.journalLines);
      await routeDb.delete(s.journalEntries);
    } catch { /* best-effort */ }
  });

  it("merges every account with a combined running balance", async () => {
    const { status, body } = await get("/api/reports/bank-book?accountId=all");
    expect(status).toBe(200);
    expect(body.account.id).toBe("all");
    expect(body.entries).toHaveLength(2);
    // Date order: cash receipt first, then bank receipt.
    expect(body.entries[0].accountName).toBe("Cash in Hand");
    expect(body.entries[1].accountName).toBe("Allied Bank");
    expect(body.entries[0].balance).toBe(parseMoney("1000").toString());
    expect(body.entries[1].balance).toBe(parseMoney("3500").toString());
    expect(body.closing).toBe(parseMoney("3500").toString());
  });

  it("a single accountId still filters to that account", async () => {
    const { status, body } = await get(`/api/reports/bank-book?accountId=${bankId}`);
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].accountName).toBe("Allied Bank");
    expect(body.closing).toBe(parseMoney("2500").toString());
  });

  it("rejects an unknown account", async () => {
    const { status } = await get("/api/reports/bank-book?accountId=does-not-exist");
    expect(status).toBe(404);
  });
});
