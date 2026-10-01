import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS } from "@/lib/setup";
import * as s from "@/db/schema";
import {
  slMonthlyPaisa,
  dbMonthlyPaisa,
  monthsElapsed,
  depreciationForMonth,
  createAsset,
  deleteAsset,
  createDepreciationRun,
  postDepreciationRun,
  voidDepreciationRun,
  sellAsset,
  disposeAsset,
  transferAsset,
  projectSchedule,
} from "@/lib/assets";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let bankId = "";
let machineryAcctId = "";

const R = (rs: number) => BigInt(rs) * 100n; // rupees → paisa

/** Register a 14xx asset-cost account for tests (mirrors the UI flow). */
async function makeAssetAccount(code: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.accounts).values({
    id, companyId, code, name, type: "ASSET",
  });
  return id;
}

async function glSumsByCode() {
  const rows = await db
    .select({
      code: s.accounts.code,
      d: s.journalLines.debit,
      c: s.journalLines.credit,
    })
    .from(s.journalLines)
    .innerJoin(s.accounts, eq(s.journalLines.accountId, s.accounts.id))
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(eq(s.journalEntries.companyId, companyId));
  const map = new Map<string, { d: bigint; c: bigint }>();
  for (const r of rows) {
    const e = map.get(r.code) ?? { d: 0n, c: 0n };
    e.d += BigInt(r.d); e.c += BigInt(r.c);
    map.set(r.code, e);
  }
  return map;
}

async function journalBalance(entryId: string) {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  const d = lines.reduce((a, l) => a + BigInt(l.debit), 0n);
  const c = lines.reduce((a, l) => a + BigInt(l.credit), 0n);
  return { d, c, lines };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await setupCompany(db, companyId);
  const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId)).limit(1);
  bankId = ba.id;
  machineryAcctId = await makeAssetAccount("1410", "Machinery");

  // Vehicle: cost Rs 1,200,000, salvage Rs 200,000, SL, 5 yrs, bought Jan 2026.
  await db.transaction((tx) =>
    createAsset(tx, {
      companyId, code: "AST-001", description: "Delivery van", assetClass: "VEHICLE",
      accountId: machineryAcctId,
      purchaseDate: new Date("2026-01-10T00:00:00Z"),
      purchaseCostPaisa: R(1200000), salvageValuePaisa: R(200000),
      depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
    })
  );
  // Computer: cost Rs 300,000, salvage 0, DB 20%/yr, bought Feb 2026.
  await db.transaction((tx) =>
    createAsset(tx, {
      companyId, code: "AST-002", description: "Workstation", assetClass: "IT_EQUIPMENT",
      accountId: machineryAcctId,
      purchaseDate: new Date("2026-02-01T00:00:00Z"),
      purchaseCostPaisa: R(300000), salvageValuePaisa: 0n,
      depreciationMethod: "DB", usefulLifeYears: 5, dbRateBps: 2000, createdById: userId,
    })
  );
});

afterAll(() => cleanup());

describe("module 9 — pure depreciation math", () => {
  it("SL monthly: (1,200,000 − 200,000) / 60 = 16,666.67 → floor 16,666.67 rupees", () => {
    // Rs 1,000,000 / 60 = Rs 16,666.666… → floor Rs 16,666.66 (1,666,666 paisa)
    expect(slMonthlyPaisa(R(1200000), R(200000), 5)).toBe(1666666n);
  });

  it("SL monthly is exact when divisible", () => {
    expect(slMonthlyPaisa(R(120000), 0n, 5)).toBe(R(2000)); // 120,000/60
  });

  it("DB monthly: 300,000 × 20% / 12 = 5,000", () => {
    expect(dbMonthlyPaisa(R(300000), 2000)).toBe(R(5000));
  });

  it("monthsElapsed counts the purchase month inclusively", () => {
    expect(monthsElapsed(new Date("2026-01-10T00:00:00Z"), 2026, 3)).toBe(3);
    expect(monthsElapsed(new Date("2026-05-01T00:00:00Z"), 2026, 3)).toBeLessThan(1);
  });

  it("floor-at-salvage: final month absorbs the SL floor remainder", () => {
    // (1,200,000 − 200,000)/60 floors at 1,666,666 paisa; after 59 months
    // 1,666,694 paisa remain — the 60th month takes it all, NBV = salvage.
    // Walk all 60 months of useful life.
    const asset = {
      purchaseDate: new Date("2026-01-10T00:00:00Z"),
      purchaseCostPaisa: R(1200000), salvageValuePaisa: R(200000),
      depreciationMethod: "SL", usefulLifeYears: 5, dbRateBps: null,
      accumDepPaisa: 0n, status: "ACTIVE",
    };
    let accum = 0n;
    let y = 2026, mo = 1;
    for (let i = 0; i < 60; i++) {
      const dep = depreciationForMonth({ ...asset, accumDepPaisa: accum }, y, mo);
      expect(dep).toBeGreaterThan(0n);
      accum += dep;
      mo++; if (mo > 12) { mo = 1; y++; }
    }
    expect(accum).toBe(R(1000000)); // exactly cost − salvage
    const nbv = R(1200000) - accum;
    expect(nbv).toBe(R(200000)); // never below salvage
    // The 61st month charges nothing.
    expect(depreciationForMonth({ ...asset, accumDepPaisa: accum }, y, mo)).toBe(0n);
  });

  it("never depreciates before purchase or after disposal", () => {
    const base = {
      purchaseDate: new Date("2026-06-01T00:00:00Z"),
      purchaseCostPaisa: R(100000), salvageValuePaisa: 0n,
      depreciationMethod: "SL", usefulLifeYears: 5, dbRateBps: null,
      accumDepPaisa: 0n, status: "ACTIVE",
    };
    expect(depreciationForMonth(base, 2026, 3)).toBe(0n);
    expect(depreciationForMonth({ ...base, status: "SOLD" }, 2026, 7)).toBe(0n);
    expect(depreciationForMonth({ ...base, status: "DISPOSED" }, 2026, 7)).toBe(0n);
  });

  it("projectSchedule lands on salvage at the end of useful life (DB)", () => {
    const rows = projectSchedule({
      purchaseDate: new Date("2026-02-01T00:00:00Z"),
      purchaseCostPaisa: R(300000), salvageValuePaisa: 0n,
      depreciationMethod: "DB", usefulLifeYears: 5, dbRateBps: 2000,
      accumDepPaisa: 0n, status: "ACTIVE",
    }, 2026, 2, 60);
    expect(rows.length).toBe(60);
    expect(rows[rows.length - 1]!.nbvAfterPaisa).toBe(0n);
  });
});

describe("module 9 — register validations", () => {
  it("rejects duplicate asset codes per company", async () => {
    await expect(
      db.transaction((tx) =>
        createAsset(tx, {
          companyId, code: "AST-001", description: "Dup", assetClass: "OTHER",
          accountId: machineryAcctId, purchaseDate: new Date("2026-03-01T00:00:00Z"),
          purchaseCostPaisa: R(10000), salvageValuePaisa: 0n,
          depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "ASSET_CODE_DUPLICATE" });
  });

  it("rejects salvage ≥ cost and non-asset accounts", async () => {
    await expect(
      db.transaction((tx) =>
        createAsset(tx, {
          companyId, code: "AST-BAD1", description: "Bad salvage", assetClass: "OTHER",
          accountId: machineryAcctId, purchaseDate: new Date("2026-03-01T00:00:00Z"),
          purchaseCostPaisa: R(10000), salvageValuePaisa: R(10000),
          depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "ASSET_SALVAGE_INVALID" });

    const cashAcct = (await db.select().from(s.accounts).where(
      and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, SYS.CASH))
    ).limit(1))[0]!;
    await expect(
      db.transaction((tx) =>
        createAsset(tx, {
          companyId, code: "AST-BAD2", description: "Cash as asset acct", assetClass: "OTHER",
          accountId: "00000000-0000-0000-0000-000000000000",
          purchaseDate: new Date("2026-03-01T00:00:00Z"),
          purchaseCostPaisa: R(10000), salvageValuePaisa: 0n,
          depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "ASSET_ACCOUNT_NOT_FOUND" });
    void cashAcct;
  });

  it("locks policy once depreciation is posted, deletes untouched assets", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.assets).values({
      id, companyId, code: "AST-DEL", description: "To delete", assetClass: "OTHER",
      accountId: machineryAcctId, purchaseDate: new Date("2026-01-01T00:00:00Z"),
      purchaseCostPaisa: R(50000), createdById: userId,
    });
    await db.transaction((tx) => deleteAsset(tx, { companyId, assetId: id }));
    const [gone] = await db.select().from(s.assets).where(eq(s.assets.id, id)).limit(1);
    expect(gone).toBeUndefined();
  });
});

describe("module 9 — depreciation runs", () => {
  it("March 2026 run charges both assets (SL + DB)", async () => {
    const runId = await db.transaction((tx) =>
      createDepreciationRun(tx, { companyId, year: 2026, month: 3, createdById: userId })
    );
    const entries = await db.select().from(s.depreciationEntries)
      .where(and(eq(s.depreciationEntries.companyId, companyId), eq(s.depreciationEntries.runId, runId)));
    expect(entries.length).toBe(2);
    const sl = entries.find((e) => e.assetCode === "AST-001")!;
    expect(BigInt(sl.depreciationPaisa)).toBe(1666666n);
    // AST-002 (DB) bought Feb: this is its first posted charge, computed on
    // the current NBV: 300,000 × 20% / 12 = 5,000.
    const dbe = entries.find((e) => e.assetCode === "AST-002")!;
    expect(BigInt(dbe.depreciationPaisa)).toBe(dbMonthlyPaisa(R(300000), 2000));
  });

  it("duplicate run for the same month is blocked (idempotent create)", async () => {
    await expect(
      db.transaction((tx) => createDepreciationRun(tx, { companyId, year: 2026, month: 3, createdById: userId }))
    ).rejects.toMatchObject({ code: "DEP_RUN_ALREADY_EXISTS" });
  });

  it("post writes ONE balanced journal and charges sub-ledgers", async () => {
    const [run] = await db.select().from(s.depreciationRuns)
      .where(and(eq(s.depreciationRuns.companyId, companyId), eq(s.depreciationRuns.year, 2026), eq(s.depreciationRuns.month, 3))).limit(1);
    const { journalEntryId } = await db.transaction((tx) =>
      postDepreciationRun(tx, { companyId, runId: run!.id, createdById: userId })
    );
    const bal = await journalBalance(journalEntryId);
    expect(bal.d).toBe(bal.c);
    expect(bal.d).toBeGreaterThan(0n);

    // Dr 6013 / Cr 1400 shape.
    const sums = await glSumsByCode();
    expect(sums.get(SYS.DEPRECIATION_EXPENSE)).toBeDefined();
    expect(sums.get(SYS.DEPRECIATION_EXPENSE)!.d).toBe(bal.d);
    expect(sums.get(SYS.ACCUM_DEPRECIATION)!.c).toBe(bal.c);

    const [a1] = await db.select().from(s.assets)
      .where(and(eq(s.assets.companyId, companyId), eq(s.assets.code, "AST-001"))).limit(1);
    expect(BigInt(a1!.accumDepPaisa)).toBe(1666666n);
  });

  it("re-post is blocked (status guard)", async () => {
    const [run] = await db.select().from(s.depreciationRuns)
      .where(and(eq(s.depreciationRuns.companyId, companyId), eq(s.depreciationRuns.year, 2026), eq(s.depreciationRuns.month, 3))).limit(1);
    await expect(
      db.transaction((tx) => postDepreciationRun(tx, { companyId, runId: run!.id, createdById: userId }))
    ).rejects.toMatchObject({ code: "DEP_RUN_NOT_DRAFT" });
  });

  it("void reverses the GL to zero and restores sub-ledgers", async () => {
    const [run] = await db.select().from(s.depreciationRuns)
      .where(and(eq(s.depreciationRuns.companyId, companyId), eq(s.depreciationRuns.year, 2026), eq(s.depreciationRuns.month, 3))).limit(1);
    const { reversingJournalEntryId } = await db.transaction((tx) =>
      voidDepreciationRun(tx, { companyId, runId: run!.id, createdById: userId })
    );
    const bal = await journalBalance(reversingJournalEntryId);
    expect(bal.d).toBe(bal.c);
    expect(bal.d).toBeGreaterThan(0n);

    const sums = await glSumsByCode();
    expect(sums.get(SYS.DEPRECIATION_EXPENSE)!.d - sums.get(SYS.DEPRECIATION_EXPENSE)!.c).toBe(0n);
    expect(sums.get(SYS.ACCUM_DEPRECIATION)!.c - sums.get(SYS.ACCUM_DEPRECIATION)!.d).toBe(0n);

    const [a1] = await db.select().from(s.assets)
      .where(and(eq(s.assets.companyId, companyId), eq(s.assets.code, "AST-001"))).limit(1);
    expect(BigInt(a1!.accumDepPaisa)).toBe(0n);
    expect(a1!.status).toBe("ACTIVE");
  });

  it("a voided month cannot be re-run (the voided run stays as audit trail)", async () => {
    // Same as payroll: the UNIQUE (company, year, month) index is the backstop.
    await expect(
      db.transaction((tx) => createDepreciationRun(tx, { companyId, year: 2026, month: 3, createdById: userId }))
    ).rejects.toMatchObject({ code: "DEP_RUN_ALREADY_EXISTS" });

    // A fresh month works and charges one month only.
    const runId = await db.transaction((tx) =>
      createDepreciationRun(tx, { companyId, year: 2026, month: 4, createdById: userId })
    );
    await db.transaction((tx) => postDepreciationRun(tx, { companyId, runId, createdById: userId }));
    const [a1] = await db.select().from(s.assets)
      .where(and(eq(s.assets.companyId, companyId), eq(s.assets.code, "AST-001"))).limit(1);
    expect(BigInt(a1!.accumDepPaisa)).toBe(1666666n);
  });
});

describe("module 9 — asset movements", () => {
  let saleAssetId = "";

  beforeAll(async () => {
    // Fresh asset, depreciated once, then sold.
    saleAssetId = await db.transaction((tx) =>
      createAsset(tx, {
        companyId, code: "AST-SALE", description: "Old generator", assetClass: "MACHINERY",
        accountId: machineryAcctId, purchaseDate: new Date("2026-01-05T00:00:00Z"),
        purchaseCostPaisa: R(500000), salvageValuePaisa: R(50000),
        depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
      })
    );
    const runId = await db.transaction((tx) =>
      createDepreciationRun(tx, { companyId, year: 2026, month: 5, createdById: userId })
    );
    await db.transaction((tx) => postDepreciationRun(tx, { companyId, runId, createdById: userId }));
  });

  it("sale above NBV posts a gain to 4110 with a balanced journal", async () => {
    // SL monthly = (500,000−50,000)/60 = 7,500. NBV after May run = 492,500.
    const { journalEntryId, gainLossPaisa } = await db.transaction((tx) =>
      sellAsset(tx, {
        companyId, assetId: saleAssetId, salePricePaisa: R(500000),
        date: new Date("2026-06-10T00:00:00Z"), bankAccountId: bankId, createdById: userId,
      })
    );
    expect(gainLossPaisa).toBe(R(500000) - R(492500)); // +7,500 gain
    const bal = await journalBalance(journalEntryId);
    expect(bal.d).toBe(bal.c);
    // Dr bank 500,000 + Dr accum dep 7,500 = Cr 1410 cost 500,000 + Cr 4110 gain 7,500.
    expect(bal.d).toBe(R(507500));

    const sums = await glSumsByCode();
    expect(sums.get(SYS.GAIN_ON_DISPOSAL)!.c).toBe(R(7500));

    const [a] = await db.select().from(s.assets).where(eq(s.assets.id, saleAssetId)).limit(1);
    expect(a!.status).toBe("SOLD");
  });

  it("sale below NBV posts a loss to 6030", async () => {
    const id = await db.transaction((tx) =>
      createAsset(tx, {
        companyId, code: "AST-LOSS", description: "Crashed bike", assetClass: "VEHICLE",
        accountId: machineryAcctId, purchaseDate: new Date("2026-01-05T00:00:00Z"),
        purchaseCostPaisa: R(200000), salvageValuePaisa: 0n,
        depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
      })
    );
    const { journalEntryId, gainLossPaisa } = await db.transaction((tx) =>
      sellAsset(tx, {
        companyId, assetId: id, salePricePaisa: R(150000),
        date: new Date("2026-06-12T00:00:00Z"), bankAccountId: bankId, createdById: userId,
      })
    );
    expect(gainLossPaisa).toBe(-R(50000)); // loss of 50,000
    const bal = await journalBalance(journalEntryId);
    expect(bal.d).toBe(bal.c);
    const sums = await glSumsByCode();
    expect(sums.get(SYS.LOSS_ON_DISPOSAL)!.d).toBe(R(50000));
  });

  it("sold assets are excluded from future runs", async () => {
    const runId = await db.transaction((tx) =>
      createDepreciationRun(tx, { companyId, year: 2026, month: 6, createdById: userId })
    );
    const entries = await db.select().from(s.depreciationEntries)
      .where(and(eq(s.depreciationEntries.companyId, companyId), eq(s.depreciationEntries.runId, runId)));
    const codes = entries.map((e) => e.assetCode);
    expect(codes).not.toContain("AST-SALE");
    expect(codes).not.toContain("AST-LOSS");
  });

  it("disposal posts remaining NBV as loss to 6030, status DISPOSED", async () => {
    // Purchased in July — after the June run — so no depreciation is charged.
    const id = await db.transaction((tx) =>
      createAsset(tx, {
        companyId, code: "AST-SCRAP", description: "Broken drill", assetClass: "MACHINERY",
        accountId: machineryAcctId, purchaseDate: new Date("2026-07-02T00:00:00Z"),
        purchaseCostPaisa: R(120000), salvageValuePaisa: 0n,
        depreciationMethod: "SL", usefulLifeYears: 5, createdById: userId,
      })
    );
    const { journalEntryId } = await db.transaction((tx) =>
      disposeAsset(tx, { companyId, assetId: id, date: new Date("2026-07-15T00:00:00Z"), createdById: userId })
    );
    const bal = await journalBalance(journalEntryId);
    expect(bal.d).toBe(bal.c);
    expect(bal.d).toBe(R(120000)); // Dr 1400 0 + Dr 6030 120,000 / Cr 1410 120,000
    const [a] = await db.select().from(s.assets).where(eq(s.assets.id, id)).limit(1);
    expect(a!.status).toBe("DISPOSED");
    expect(BigInt(a!.gainLossPaisa)).toBe(-R(120000));
  });

  it("transfer moves the branch with no journal", async () => {
    const [a1] = await db.select().from(s.assets)
      .where(and(eq(s.assets.companyId, companyId), eq(s.assets.code, "AST-001"))).limit(1);
    const [br] = await db.select().from(s.branches).where(eq(s.branches.companyId, companyId)).limit(1);
    const before = await glSumsByCode();
    await db.transaction((tx) =>
      transferAsset(tx, { companyId, assetId: a1!.id, toBranchId: br!.id, createdById: userId })
    );
    const after = await glSumsByCode();
    expect(after).toEqual(before); // no ledger impact
    const [moved] = await db.select().from(s.assets).where(eq(s.assets.id, a1!.id)).limit(1);
    expect(moved!.branchId).toBe(br!.id);
  });

  it("sold assets cannot be re-sold or disposed", async () => {
    await expect(
      db.transaction((tx) =>
        sellAsset(tx, {
          companyId, assetId: saleAssetId, salePricePaisa: R(1000),
          date: new Date("2026-07-01T00:00:00Z"), bankAccountId: bankId, createdById: userId,
        })
      )
    ).rejects.toMatchObject({ code: "ASSET_SALE_INVALID_STATUS" });
  });
});

describe("module 9 — SYS accounts", () => {
  it("setupCompany creates the module-9 system accounts", async () => {
    const codes = [SYS.DEPRECIATION_EXPENSE, SYS.ACCUM_DEPRECIATION, SYS.GAIN_ON_DISPOSAL, SYS.LOSS_ON_DISPOSAL];
    for (const code of codes) {
      const [row] = await db.select().from(s.accounts)
        .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code))).limit(1);
      expect(row, code).toBeDefined();
    }
  });

  it("accum-dep is an ASSET account so type-based BS nets it against 14xx cost", () => {
    const sums = new Map([
      ["1410", { debit: R(1200000), credit: 0n, name: "Machinery", type: "ASSET" }],
      [SYS.ACCUM_DEPRECIATION, { debit: 0n, credit: R(20000), name: "Accumulated Depreciation", type: "ASSET" }],
    ]);
    let total = 0n;
    for (const [, v] of sums) if (v.type === "ASSET") total += v.debit - v.credit;
    expect(total).toBe(R(1180000)); // contra-asset reduces fixed assets
  });
});
