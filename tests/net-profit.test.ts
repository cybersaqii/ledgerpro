import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { postExpense } from "@/lib/posting";
import { netProfit } from "@/lib/reports";
import { parseMoney } from "@/lib/money";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let rentAccountId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  rentAccountId = crypto.randomUUID();
  await db.insert(s.accounts).values({ id: rentAccountId, companyId, code: "6001", name: "Shop Rent", type: "EXPENSE" });
  const cash = await db
    .select({ id: s.bankAccounts.id })
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashAccountId = cash[0]!.id;
});

afterAll(() => cleanup());

describe("netProfit", () => {
  it("returns 0 for a fresh company", async () => {
    expect(await netProfit(db, companyId)).toBe("0");
  });

  it("reflects posted expenses as negative profit", async () => {
    await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: rentAccountId, bankAccountId: cashAccountId,
        date: new Date(), amount: parseMoney("500"), taxAmount: 0n, createdById: userId,
      })
    );
    expect(await netProfit(db, companyId)).toBe((-parseMoney("500")).toString());
  });

  it("respects the from date filter", async () => {
    // The Rs 500 expense was posted today; it must appear in today's range
    // and disappear when the range starts in the future.
    const todayISO = new Date().toISOString().slice(0, 10);
    const futureISO = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    expect(await netProfit(db, companyId, todayISO, null)).toBe((-parseMoney("500")).toString());
    expect(await netProfit(db, companyId, futureISO, null)).toBe("0");
  });
});
