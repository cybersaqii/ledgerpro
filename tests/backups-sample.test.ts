import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import {
  MAX_BACKUP_BYTES,
  MAX_AUTO_BACKUPS,
  backupAllCompanies,
  backupCompany,
  buildBackupPayload,
  enforceRetention,
  listBackups,
  serializeBackup,
  validateBackupPayload,
  verifyCronSecret,
} from "@/lib/backup";
import {
  SAMPLE_PREFIX,
  hasRealData,
  isSampleLoaded,
  loadSampleData,
  removeSampleData,
} from "@/lib/sample-data";
import { computeOnboardingSteps } from "@/lib/security";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function makeCompany(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.companies).values({ id, name });
  return id;
}

async function makeBranch(companyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.branches).values({ id, companyId, name: "Main", isDefault: true });
  return id;
}

async function makeExpenseAccount(companyId: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.accounts).values({ id, companyId, code: "6000", name: "Test Expense", type: "EXPENSE" });
  return id;
}

async function makeBank(companyId: string): Promise<string> {
  const glId = crypto.randomUUID();
  await db.insert(s.accounts).values({ id: glId, companyId, code: "1001", name: "Cash", type: "ASSET" });
  const id = crypto.randomUUID();
  await db.insert(s.bankAccounts).values({ id, companyId, name: "Cash Box", kind: "CASH", accountId: glId, balance: 0n });
  return id;
}

async function backupCount(companyId: string): Promise<number> {
  const rows = await db.select({ id: s.backups.id }).from(s.backups).where(eq(s.backups.companyId, companyId));
  return rows.length;
}

describe("cron secret check", () => {
  it("accepts the exact secret, rejects everything else", () => {
    expect(verifyCronSecret("s3cr3t", "s3cr3t")).toBe(true);
    expect(verifyCronSecret(null, "s3cr3t")).toBe(false);
    expect(verifyCronSecret("wrong", "s3cr3t")).toBe(false);
    expect(verifyCronSecret("s3cr3t", undefined)).toBe(false);
    expect(verifyCronSecret("", "s3cr3t")).toBe(false);
    expect(verifyCronSecret("s3cr3t ", "s3cr3t")).toBe(false); // length differs
  });
});

describe("backupCompany", () => {
  it("stores a backup row with row counts", async () => {
    const cid = await makeCompany("Backup Co");
    const r = await backupCompany(db, cid, "manual");
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(r.byteSize).toBeGreaterThan(0);
    expect(r.rowCounts.parties).toBe(0);
    const list = await listBackups(db, cid);
    expect(list).toHaveLength(1);
    expect(list[0].trigger).toBe("manual");
    expect(list[0].byteSize).toBe(r.byteSize);
  });

  it("skips payloads over 8 MB and logs the skip instead of writing", async () => {
    expect(MAX_BACKUP_BYTES).toBe(8 * 1024 * 1024);
    const cid = await makeCompany("Huge Co");
    await db.insert(s.parties).values({
      id: crypto.randomUUID(), companyId: cid, kind: "CUSTOMER",
      name: "Big Notes", notes: "x".repeat(9 * 1024 * 1024),
    });
    const before = await backupCount(cid);
    const r = await backupCompany(db, cid, "auto");
    expect(r.status).toBe("skipped");
    if (r.status !== "skipped") return;
    expect(r.reason).toContain("8 MB");
    expect(await backupCount(cid)).toBe(before); // nothing written
    const logs = await db.select({ id: s.errorLogs.id }).from(s.errorLogs).where(eq(s.errorLogs.companyId, cid));
    expect(logs.length).toBeGreaterThan(0);
  });
});

describe("retention", () => {
  it("keeps the 14 newest auto backups and evicts the oldest", async () => {
    expect(MAX_AUTO_BACKUPS).toBe(14);
    const cid = await makeCompany("Retention Co");
    const now = Date.now();
    const ids: string[] = [];
    for (let i = 0; i < 15; i++) {
      const id = crypto.randomUUID();
      ids.push(id);
      await db.insert(s.backups).values({
        id, companyId: cid, createdAt: new Date(now - (14 - i) * 1000),
        byteSize: 10, rowCounts: "{}", payload: "{}", trigger: "auto",
      });
    }
    const evicted = await enforceRetention(db, cid);
    expect(evicted).toBe(1);
    expect(await backupCount(cid)).toBe(14);
    const oldest = await db.select({ id: s.backups.id }).from(s.backups).where(eq(s.backups.id, ids[0]));
    expect(oldest).toHaveLength(0); // the oldest one is gone
    const newest = await db.select({ id: s.backups.id }).from(s.backups).where(eq(s.backups.id, ids[14]));
    expect(newest).toHaveLength(1);
  });

  it("never prunes manual backups", async () => {
    const cid = await makeCompany("Manual Keep Co");
    for (let i = 0; i < 20; i++) {
      await db.insert(s.backups).values({
        id: crypto.randomUUID(), companyId: cid, byteSize: 10,
        rowCounts: "{}", payload: "{}", trigger: "manual",
      });
    }
    expect(await enforceRetention(db, cid)).toBe(0);
    expect(await backupCount(cid)).toBe(20);
  });
});

describe("backupAllCompanies failure isolation", () => {
  it("one company's failure never stops the rest", async () => {
    const good = await makeCompany("Good Co");
    const bad = await makeCompany("Bad Co");
    // Poison the backups table for the bad company only.
    await db.run(sql.raw(
      `CREATE TRIGGER fail_backup_${bad.replace(/-/g, "")} BEFORE INSERT ON backups ` +
      `WHEN NEW.company_id = '${bad}' BEGIN SELECT RAISE(ABORT, 'boom'); END;`
    ));
    try {
      const summary = await backupAllCompanies(db);
      expect(summary.companies).toBeGreaterThanOrEqual(2);
      expect(summary.failed).toBe(1);
      expect(summary.failures[0].companyId).toBe(bad);
      expect(summary.backedUp).toBeGreaterThanOrEqual(1);
      expect(await backupCount(good)).toBeGreaterThanOrEqual(1);
      expect(await backupCount(bad)).toBe(0);
      const logs = await db.select({ id: s.errorLogs.id }).from(s.errorLogs).where(eq(s.errorLogs.companyId, bad));
      expect(logs.length).toBeGreaterThan(0);
    } finally {
      await db.run(sql.raw(`DROP TRIGGER fail_backup_${bad.replace(/-/g, "")};`));
    }
  });
});

describe("validateBackupPayload (dry-run verify)", () => {
  it("accepts a real payload and reports row counts, with zero writes", async () => {
    const cid = await makeCompany("Verify Co");
    await db.insert(s.parties).values({
      id: crypto.randomUUID(), companyId: cid, kind: "CUSTOMER", name: "Real Party",
    });
    const { payload } = await buildBackupPayload(db, cid);
    const before = await backupCount(cid);
    const v = validateBackupPayload(serializeBackup(payload));
    expect(v.ok).toBe(true);
    expect(v.errors).toHaveLength(0);
    expect(v.rowCounts.parties).toBe(1);
    expect(await backupCount(cid)).toBe(before); // zero writes
  });

  it("catches a corrupted payload", () => {
    const bad = validateBackupPayload("{not json");
    expect(bad.ok).toBe(false);
    expect(bad.errors[0]).toContain("not valid JSON");

    const tampered = validateBackupPayload(JSON.stringify({ app: "LedgerPro", version: 1, company: {} }));
    expect(tampered.ok).toBe(false);
    expect(tampered.errors.some((e) => e.includes('"parties"'))).toBe(true);

    const brokenRow = validateBackupPayload(JSON.stringify({
      app: "LedgerPro", version: 1, company: { id: "x" },
      branches: [], accounts: [], parties: [{ noId: true }], products: [], bankAccounts: [],
      salesDocs: [], salesDocItems: [], purchaseDocs: [], purchaseDocItems: [],
      payments: [], paymentAllocations: [], expenses: [], journalEntries: [],
      journalLines: [], stockLevels: [], numberSequences: [],
    }));
    expect(brokenRow.ok).toBe(false);
    expect(brokenRow.errors.some((e) => e.includes("parties"))).toBe(true);
  });
});

describe("sample data", () => {
  async function freshCompany(): Promise<string> {
    const cid = await makeCompany("Sample Co " + crypto.randomUUID().slice(0, 6));
    await makeBranch(cid);
    await makeExpenseAccount(cid);
    await makeBank(cid);
    return cid;
  }

  it("loads a labeled demo dataset that never touches the real books", async () => {
    const cid = await freshCompany();
    const r = await loadSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" });
    expect(r).toEqual({ parties: 2, products: 3, docs: 3 });
    expect(await isSampleLoaded(db, cid)).toBe(true);

    const partyNames = (await db.select({ name: s.parties.name }).from(s.parties).where(eq(s.parties.companyId, cid))).map((p) => p.name);
    expect(partyNames).toHaveLength(2);
    expect(partyNames.every((n) => n.startsWith(SAMPLE_PREFIX))).toBe(true);

    const skus = (await db.select({ sku: s.products.sku }).from(s.products).where(eq(s.products.companyId, cid))).map((p) => p.sku);
    expect(skus.every((x) => x.startsWith(SAMPLE_PREFIX))).toBe(true);

    // Drafts only — no journals, no stock moves, no balances.
    const docs = await db.select({ status: s.salesDocs.status }).from(s.salesDocs).where(eq(s.salesDocs.companyId, cid));
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("DRAFT");
    const pdocs = await db.select({ status: s.purchaseDocs.status }).from(s.purchaseDocs).where(eq(s.purchaseDocs.companyId, cid));
    expect(pdocs[0].status).toBe("DRAFT");
    const ex = await db.select().from(s.expenses).where(eq(s.expenses.companyId, cid));
    expect(ex).toHaveLength(1);
    expect(ex[0].journalEntryId).toBeNull();
    expect(await db.select({ id: s.journalEntries.id }).from(s.journalEntries).where(eq(s.journalEntries.companyId, cid))).toHaveLength(0);
    expect(await db.select({ id: s.stockLevels.id }).from(s.stockLevels)).toHaveLength(0);
    const balances = (await db.select({ balance: s.parties.balance }).from(s.parties).where(eq(s.parties.companyId, cid)));
    expect(balances.every((b) => b.balance === 0n)).toBe(true);
  });

  it("refuses a second load and removes exactly what it created", async () => {
    const cid = await freshCompany();
    await loadSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" });
    await expect(loadSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" })).rejects.toThrow(UserError);

    const removed = await removeSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" });
    expect(removed.removed).toBe(12); // 2 parties + 3 products + 2 docs + 4 items + 1 expense
    expect(await isSampleLoaded(db, cid)).toBe(false);
    expect((await db.select({ id: s.parties.id }).from(s.parties).where(eq(s.parties.companyId, cid)))).toHaveLength(0);
    expect((await db.select({ id: s.products.id }).from(s.products).where(eq(s.products.companyId, cid)))).toHaveLength(0);
    expect((await db.select({ id: s.salesDocs.id }).from(s.salesDocs).where(eq(s.salesDocs.companyId, cid)))).toHaveLength(0);
    expect((await db.select({ id: s.purchaseDocs.id }).from(s.purchaseDocs).where(eq(s.purchaseDocs.companyId, cid)))).toHaveLength(0);
    expect((await db.select({ id: s.expenses.id }).from(s.expenses).where(eq(s.expenses.companyId, cid)))).toHaveLength(0);
    // Setup rows (branch, accounts, bank) survive — they were never sample rows.
    expect((await db.select({ id: s.branches.id }).from(s.branches).where(eq(s.branches.companyId, cid)))).toHaveLength(1);
    await expect(removeSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" })).rejects.toThrow(UserError);
  });

  it("is blocked when the company already has real data (never mixes)", async () => {
    const cid = await freshCompany();
    await db.insert(s.parties).values({
      id: crypto.randomUUID(), companyId: cid, kind: "CUSTOMER", name: "Real Customer",
    });
    expect(await hasRealData(db, cid)).toBe(true);
    await expect(loadSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" })).rejects.toThrow(/brand-new/);
    expect(await isSampleLoaded(db, cid)).toBe(false);
  });

  it("sample rows never count as real data", async () => {
    const cid = await freshCompany();
    await loadSampleData(db, { companyId: cid, userId: "u1", userName: "Owner" });
    expect(await hasRealData(db, cid)).toBe(false);
  });
});

describe("onboarding sample step", () => {
  const base = {
    profileComplete: true, hasParty: false, hasProduct: false,
    hasSale: false, hasTeammate: false, teamLocked: false,
  };
  it("shows a one-click sample step to owners only", () => {
    const ownerSteps = computeOnboardingSteps({ ...base, sampleLoaded: false, isOwner: true });
    const step = ownerSteps.find((x) => x.key === "sample");
    expect(step).toBeDefined();
    expect(step!.action).toBe("load-sample");
    expect(step!.done).toBe(false);
    const staffSteps = computeOnboardingSteps({ ...base, sampleLoaded: false, isOwner: false });
    expect(staffSteps.find((x) => x.key === "sample")).toBeUndefined();
  });
  it("marks the sample step done once loaded or when real data exists", () => {
    const loaded = computeOnboardingSteps({ ...base, sampleLoaded: true, isOwner: true });
    expect(loaded.find((x) => x.key === "sample")!.done).toBe(true);
    const real = computeOnboardingSteps({ ...base, hasParty: true, hasProduct: true, sampleLoaded: false, isOwner: true });
    expect(real.find((x) => x.key === "sample")!.done).toBe(true);
  });
});
