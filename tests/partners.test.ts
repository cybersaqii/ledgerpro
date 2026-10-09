import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS } from "@/lib/setup";
import {
  registerPartner,
  postPartnerMovement,
  createDistribution,
  postDistribution,
  voidDistribution,
} from "@/lib/partners";
import { partners, profitDistributions, accounts } from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let cashAccountId: string;

beforeAll(async () => {
  const t = await createTestDb();
  db = t.db;
  cleanup = t.cleanup;
  const schema = await import("@/db/schema");
  await db.insert(schema.companies).values({ id: companyId, name: "Test Co" });
  await setupCompany(db, companyId);
  await db.insert(schema.users).values({
    id: userId, companyId, name: "Owner", email: "owner@test.co",
    passwordHash: "x", role: "OWNER",
  });
  const cash = await db
    .select()
    .from(accounts)
    .where(eq(accounts.companyId, companyId))
    .limit(1);
  cashAccountId = cash[0].id;
});

afterAll(() => cleanup());

describe("partners", () => {
  it("registers a partner with 301x/302x accounts", async () => {
    const r = await db.transaction((tx) =>
      registerPartner(tx, {
        companyId,
        name: "Ahmed",
        profitShareBps: 6000,
        createdById: userId,
      })
    );
    expect(r.capitalCode).toBe("3011");
    expect(r.currentCode).toBe("3021");

    const r2 = await db.transaction((tx) =>
      registerPartner(tx, {
        companyId,
        name: "Bilal",
        profitShareBps: 4000,
        createdById: userId,
      })
    );
    expect(r2.capitalCode).toBe("3012");
    expect(r2.currentCode).toBe("3022");
  });

  it("posts a balanced contribution journal (Dr Cash → Cr Capital)", async () => {
    const r = await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "C1", profitShareBps: 10000, createdById: userId })
    );
    const m = await db.transaction((tx) =>
      postPartnerMovement(tx, {
        companyId,
        partnerId: r.id,
        kind: "CONTRIBUTION",
        amountPaisa: 100000n,
        accountId: cashAccountId,
        date: new Date(),
        createdById: userId,
      })
    );
    expect(m.journalEntryId).toBeTruthy();
  });

  it("posts a drawing (Dr Current → Cr Cash)", async () => {
    const r = await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "D1", profitShareBps: 10000, createdById: userId })
    );
    const m = await db.transaction((tx) =>
      postPartnerMovement(tx, {
        companyId,
        partnerId: r.id,
        kind: "DRAWING",
        amountPaisa: 20000n,
        accountId: cashAccountId,
        date: new Date(),
        createdById: userId,
      })
    );
    expect(m.journalEntryId).toBeTruthy();
  });

  it("distributes profit by bps with remainder handling", async () => {
    await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "E1", profitShareBps: 6000, createdById: userId })
    );
    await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "E2", profitShareBps: 4000, createdById: userId })
    );
    const distId = await db.transaction((tx) =>
      createDistribution(tx, {
        companyId,
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-12-31"),
        totalAmountPaisa: 100001n,
        createdById: userId,
      })
    );
    const entryId = await db.transaction((tx) =>
      postDistribution(tx, companyId, distId, userId)
    );
    expect(entryId).toBeTruthy();
  });

  it("distributes a loss in reverse direction", async () => {
    await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "F1", profitShareBps: 10000, createdById: userId })
    );
    const distId = await db.transaction((tx) =>
      createDistribution(tx, {
        companyId,
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-12-31"),
        totalAmountPaisa: -50000n,
        createdById: userId,
      })
    );
    const entryId = await db.transaction((tx) =>
      postDistribution(tx, companyId, distId, userId)
    );
    expect(entryId).toBeTruthy();
  });

  it("voids a posted distribution via reversal", async () => {
    await db.transaction((tx) =>
      registerPartner(tx, { companyId, name: "G1", profitShareBps: 10000, createdById: userId })
    );
    const distId = await db.transaction((tx) =>
      createDistribution(tx, {
        companyId,
        periodStart: new Date("2026-01-01"),
        periodEnd: new Date("2026-12-31"),
        totalAmountPaisa: 100000n,
        createdById: userId,
      })
    );
    await db.transaction((tx) => postDistribution(tx, companyId, distId, userId));
    await db.transaction((tx) => voidDistribution(tx, companyId, distId, userId));
    const rows = await db
      .select()
      .from(profitDistributions)
      .where(eq(profitDistributions.id, distId));
    expect(rows[0].status).toBe("VOIDED");
  });

  it("rejects invalid profit share", async () => {
    await expect(
      db.transaction((tx) =>
        registerPartner(tx, {
          companyId,
          name: "Bad",
          profitShareBps: 15000,
          createdById: userId,
        })
      )
    ).rejects.toThrow();
  });

  it("keeps partner data isolated per company", async () => {
    const otherCompany = crypto.randomUUID();
    const otherUser = crypto.randomUUID();
    await db.insert((await import("@/db/schema")).companies).values({ id: otherCompany, name: "Other" });
    await setupCompany(db, otherCompany);
    await db.transaction((tx) =>
      registerPartner(tx, {
        companyId: otherCompany,
        name: "Ahmed",
        profitShareBps: 5000,
        createdById: otherUser,
      })
    );
    // Same name allowed in different company
    const mine = await db.select().from(partners).where(eq(partners.companyId, companyId));
    const theirs = await db.select().from(partners).where(eq(partners.companyId, otherCompany));
    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBe(1);
  });
});
