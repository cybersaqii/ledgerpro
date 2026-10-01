/**
 * Module 16 — Parametric Reports Engine.
 *
 * Covers: param validation (stable error codes), time-bucketing boundaries
 * (day/week/month/quarter/fiscal-year), pivot grouping math (bigint Dr/Cr/net),
 * running balances, variance %, comparative previous-period computation,
 * the real engine query over journal lines (company isolation, date/entity
 * filters, reversing entries netting to zero), trial-balance preset parity
 * with glSums, and saved-report tenant isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { postManualJournal } from "@/lib/journal-vouchers";
import * as s from "@/db/schema";
import {
  validateReportParams,
  bucketKey,
  bucketStartMs,
  weekStartMs,
  fiscalYearLabelFor,
  pivotLines,
  runningBalance,
  variancePct,
  prevPeriod,
  dateRangeMs,
  type EngineLine,
} from "@/lib/report-engine";
import { fetchEngineLines, getPreset, listPresets, REPORT_PRESETS } from "@/lib/report-presets";
import { UserError } from "@/lib/errors";

const D = (iso: string) => new Date(`${iso}T12:00:00Z`);

function line(over: Partial<EngineLine>): EngineLine {
  return {
    entryId: "e1",
    dateMs: Date.UTC(2026, 9, 1),
    debit: 0n,
    credit: 0n,
    accountId: "a1",
    accountCode: "4001",
    accountName: "Sales",
    accountType: "INCOME",
    partyId: null,
    partyName: null,
    projectId: null,
    projectName: null,
    branchId: null,
    branchName: null,
    memo: "",
    reference: null,
    docNo: null,
    source: "MANUAL",
    sourceId: null,
    ...over,
  };
}

describe("16.1 param validation", () => {
  it("applies defaults for an empty object", () => {
    const p = validateReportParams({});
    expect(p).toMatchObject({ bucket: "none", groupBy: "none", view: "summary", status: "posted" });
    expect(p.from).toBeUndefined();
  });

  it("rejects an unknown bucket with a stable code", () => {
    try {
      validateReportParams({ bucket: "fortnight" });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(UserError);
      expect((e as UserError).code).toBe("BAD_REPORT_PARAM");
    }
  });

  it("rejects from > to", () => {
    expect(() => validateReportParams({ from: "2026-10-02", to: "2026-10-01" })).toThrowError(/from must not be after to/);
  });

  it("rejects malformed dates and ids", () => {
    expect(() => validateReportParams({ from: "01-10-2026" })).toThrowError(UserError);
    expect(() => validateReportParams({ from: "2026-13-01" })).toThrowError(UserError);
    expect(() => validateReportParams({ partyId: "no spaces allowed!" })).toThrowError(UserError);
  });

  it("accepts the full valid matrix", () => {
    const p = validateReportParams({
      from: "2026-01-01", to: "2026-12-31", bucket: "month", groupBy: "party",
      view: "comparative", status: "all", partyId: "abc-123", projectId: "PRJ_x",
    });
    expect(p.bucket).toBe("month");
    expect(p.view).toBe("comparative");
    expect(p.partyId).toBe("abc-123");
  });
});

describe("16.2 time bucketing boundaries", () => {
  it("buckets days, months, quarters", () => {
    const ms = Date.UTC(2026, 9, 1, 15, 30); // 2026-10-01
    expect(bucketKey(ms, "day")).toBe("2026-10-01");
    expect(bucketKey(ms, "month")).toBe("2026-10");
    expect(bucketKey(ms, "quarter")).toBe("2026-Q4");
    expect(bucketKey(Date.UTC(2026, 0, 15), "quarter")).toBe("2026-Q1");
  });

  it("starts weeks on Monday", () => {
    // 2026-10-01 is a Thursday → week starts Monday 2026-09-28
    expect(weekStartMs(Date.UTC(2026, 9, 1))).toBe(Date.UTC(2026, 8, 28));
    expect(bucketKey(Date.UTC(2026, 9, 1), "week")).toBe("2026-W40");
  });

  it("labels fiscal years around the July boundary (default 07-01)", () => {
    expect(fiscalYearLabelFor(Date.UTC(2026, 9, 1))).toBe("2026-27");
    expect(fiscalYearLabelFor(Date.UTC(2026, 5, 30))).toBe("2025-26"); // 2026-06-30
    expect(fiscalYearLabelFor(Date.UTC(2026, 6, 1))).toBe("2026-27"); // 2026-07-01
    expect(bucketKey(Date.UTC(2026, 9, 1), "fiscalYear")).toBe("2026-27");
  });

  it("round-trips bucket keys to sortable starts", () => {
    expect(bucketStartMs("2026-10-01", "day")).toBe(Date.UTC(2026, 9, 1));
    expect(bucketStartMs("2026-10", "month")).toBe(Date.UTC(2026, 9, 1));
    expect(bucketStartMs("2026-Q4", "quarter")).toBe(Date.UTC(2026, 9, 1));
    expect(bucketStartMs("2026-W40", "week")).toBe(Date.UTC(2026, 8, 28));
    expect(bucketStartMs("2026-27", "fiscalYear")).toBe(Date.UTC(2026, 6, 1));
    expect(bucketStartMs("2026-10", "month")).toBeLessThan(bucketStartMs("2026-11", "month"));
  });

  it("maps date ranges to [inclusive, exclusive) ms", () => {
    const [f, t] = dateRangeMs("2026-10-01", "2026-10-01");
    expect(f).toBe(Date.UTC(2026, 9, 1));
    expect(t).toBe(Date.UTC(2026, 9, 2));
    expect(dateRangeMs()).toEqual([null, null]);
  });

  it("computes the identical-length previous period", () => {
    const [pf, pt] = prevPeriod(Date.UTC(2026, 0, 1), Date.UTC(2026, 1, 1));
    expect(pf).toBe(Date.UTC(2025, 11, 1));
    expect(pt).toBe(Date.UTC(2026, 0, 1));
    expect(() => prevPeriod(100, 100)).toThrowError(UserError);
  });
});

describe("16.3 pivot grouping math", () => {
  const lines = [
    line({ entryId: "e1", accountCode: "4001", accountName: "Sales", accountType: "INCOME", debit: 0n, credit: 100000n, partyId: "p1", partyName: "Ali" }),
    line({ entryId: "e1", accountCode: "1001", accountName: "Cash", accountType: "ASSET", debit: 100000n, credit: 0n, partyId: "p1", partyName: "Ali" }),
    line({ entryId: "e2", accountCode: "4001", accountName: "Sales", accountType: "INCOME", debit: 0n, credit: 50000n, partyId: "p2", partyName: "Babar" }),
    line({ entryId: "e2", accountCode: "1001", accountName: "Cash", accountType: "ASSET", debit: 50000n, credit: 0n, partyId: "p2", partyName: "Babar" }),
  ];

  it("sums Dr/Cr/net per account with bigint", () => {
    const rows = pivotLines(lines, "account");
    const sales = rows.find((r) => r.groupKey === "4001")!;
    expect(sales.debit).toBe(0n);
    expect(sales.credit).toBe(150000n);
    expect(sales.net).toBe(-150000n);
    expect(sales.count).toBe(2);
    const cash = rows.find((r) => r.groupKey === "1001")!;
    expect(cash.net).toBe(150000n);
  });

  it("groups by party and by month", () => {
    const byParty = pivotLines(lines, "party");
    expect(byParty.find((r) => r.groupKey === "p1")!.credit).toBe(100000n);
    const byMonth = pivotLines(lines, "month");
    expect(byMonth).toHaveLength(1);
    expect(byMonth[0].groupKey).toBe("2026-10");
  });

  it("collapses to one total row for groupBy=none", () => {
    const rows = pivotLines(lines, "none");
    expect(rows).toHaveLength(1);
    expect(rows[0].debit).toBe(rows[0].credit);
    expect(rows[0].count).toBe(4);
  });

  it("keeps full precision on large paisa values", () => {
    const big = pivotLines([line({ debit: 9007199254740993n, credit: 0n })], "none");
    expect(big[0].debit).toBe(9007199254740993n); // beyond float precision
  });
});

describe("16.4 variance and running balance", () => {
  it("computes 2-decimal variance with pure bigint math", () => {
    expect(variancePct(11000n, 10000n)).toBe("10.00");
    expect(variancePct(9000n, 10000n)).toBe("-10.00");
    expect(variancePct(10000n, 10000n)).toBe("0.00");
    expect(variancePct(1000n, 3000n)).toBe("-66.67"); // rounds half away from zero
    expect(variancePct(5000n, 0n)).toBeNull(); // undefined when prev is 0
  });

  it("runs balances in date order with the right normal side", () => {
    const ls = [
      line({ dateMs: Date.UTC(2026, 9, 3), debit: 5000n }),
      line({ dateMs: Date.UTC(2026, 9, 1), debit: 10000n }),
      line({ dateMs: Date.UTC(2026, 9, 2), credit: 3000n }),
    ];
    const seq = runningBalance(ls, false);
    expect(seq.map((s) => s.balance)).toEqual([10000n, 7000n, 12000n]);
    const seqCr = runningBalance(ls, true);
    expect(seqCr.map((s) => s.balance)).toEqual([-10000n, -7000n, -12000n]);
  });
});

// ─── DB-backed: the real engine query ─────────────────────────────────────

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const R = (rs: number) => BigInt(rs) * 100n;

let ac: Record<string, string>;
let branchId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const setup = await setupCompany(db, companyId);
  branchId = setup.branchId;
  await setupCompany(db, otherCompanyId);
  ac = await db.transaction((tx) => accountMap(tx, companyId));

  // Oct 2026: cash sale Rs 1,000 (Dr 1001 / Cr 4001), tagged to branch.
  await db.transaction((tx) =>
    postManualJournal(tx, {
      companyId,
      branchId,
      date: D("2026-10-05"),
      memo: "cash sale",
      createdById: userId,
      lines: [
        { accountId: ac[SYS.CASH], debit: R(1000), credit: 0n },
        { accountId: ac["4001"], debit: 0n, credit: R(1000) },
      ],
    })
  );
  // Sep 2026: expense Rs 200 (Dr 6000 / Cr 1001).
  await db.transaction((tx) =>
    postManualJournal(tx, {
      companyId,
      branchId,
      date: D("2026-09-10"),
      memo: "expense",
      createdById: userId,
      lines: [
        { accountId: ac[SYS.EXPENSES], debit: R(200), credit: 0n },
        { accountId: ac[SYS.CASH], debit: 0n, credit: R(200) },
      ],
    })
  );
  // A reversing pair in Oct: +500 then −500 on 4001 — nets to zero.
  const rev = await db.transaction((tx) =>
    postManualJournal(tx, {
      companyId,
      branchId,
      date: D("2026-10-06"),
      memo: "to reverse",
      createdById: userId,
      lines: [
        { accountId: ac[SYS.CASH], debit: R(500), credit: 0n },
        { accountId: ac["4001"], debit: 0n, credit: R(500) },
      ],
    })
  );
  await db.transaction((tx) =>
    postManualJournal(tx, {
      companyId,
      branchId,
      date: D("2026-10-07"),
      memo: `reversal of ${rev.docNo}`,
      createdById: userId,
      lines: [
        { accountId: ac["4001"], debit: R(500), credit: 0n },
        { accountId: ac[SYS.CASH], debit: 0n, credit: R(500) },
      ],
    })
  );
  // Other company: must never leak in.
  const ac2 = await db.transaction((tx) => accountMap(tx, otherCompanyId));
  await db.transaction((tx) =>
    postManualJournal(tx, {
      companyId: otherCompanyId,
      date: D("2026-10-05"),
      memo: "other co",
      createdById: userId,
      lines: [
        { accountId: ac2[SYS.CASH], debit: R(999), credit: 0n },
        { accountId: ac2["4001"], debit: 0n, credit: R(999) },
      ],
    })
  );
}, 60000);

afterAll(() => cleanup());

const ctxFor = (params: Record<string, unknown>) => ({
  db,
  companyId,
  params: validateReportParams(params),
  fyStart: "07-01",
});

describe("16.5 engine query: isolation, filters, netting", () => {
  it("is company-isolated: other company's lines never appear", async () => {
    const lines = await fetchEngineLines(ctxFor({}));
    expect(lines.length).toBeGreaterThan(0);
    // 4 entries × 2 lines = 8 lines for companyId (sale, expense, sale2, reversal)
    expect(lines).toHaveLength(8);
  });

  it("filters by date range", async () => {
    const oct = await fetchEngineLines(ctxFor({ from: "2026-10-01", to: "2026-10-31" }));
    expect(oct).toHaveLength(6); // sale + reversal pair
    const sep = await fetchEngineLines(ctxFor({ from: "2026-09-01", to: "2026-09-30" }));
    expect(sep).toHaveLength(2);
  });

  it("filters by branch", async () => {
    const hit = await fetchEngineLines(ctxFor({ branchId }));
    expect(hit.length).toBe(8);
    const miss = await fetchEngineLines(ctxFor({ branchId: "no-such-branch-1" }));
    expect(miss).toHaveLength(0);
  });

  it("lets reversing entries net to zero in a pivot", async () => {
    const lines = await fetchEngineLines(ctxFor({ from: "2026-10-01", to: "2026-10-31" }), {
      accountCodes: ["4001"],
    });
    const piv = pivotLines(lines, "account");
    // 1000 + 500 − 500 = 1000 credit-normal income
    expect(piv[0].credit - piv[0].debit).toBe(R(1000));
  });

  it("trial-balance preset matches glSums and balances", async () => {
    const preset = getPreset("trial-balance");
    const res = await preset.run(ctxFor({ from: "2026-01-01", to: "2026-12-31" }));
    const tot = Object.fromEntries(res.totals!.map((t) => [t.label, BigInt(t.value)]));
    expect(tot["Total debit"]).toBe(tot["Total credit"]);
    expect(res.meta!.balanced).toBe("true");
    // Cash: +1000 −200 +500 −500 = 800
    const cash = res.rows.find((r) => r[0] === SYS.CASH)!;
    expect(BigInt(cash[3] as string) - BigInt(cash[4] as string)).toBe(R(800));
  });

  it("comparative-pnl nets the previous period correctly", async () => {
    const preset = getPreset("comparative-pnl");
    const res = await preset.run(ctxFor({ from: "2026-10-01", to: "2026-10-31", view: "comparative" }));
    const income = res.rows[0];
    expect(BigInt(income[1] as string)).toBe(R(1000)); // Oct income (reversals net)
    expect(BigInt(income[2] as string)).toBe(0n); // Sep had no income
    const expense = res.rows[1];
    expect(BigInt(expense[1] as string)).toBe(0n);
    expect(BigInt(expense[2] as string)).toBe(R(200)); // Sep expense
  });

  it("variance view renders % strings", async () => {
    const preset = getPreset("comparative-pnl");
    const res = await preset.run(ctxFor({ from: "2026-10-01", to: "2026-10-31", view: "variance" }));
    expect(res.columns.map((c) => c.key)).toContain("variance");
    // Oct income 1000 vs Sep 0 → undefined variance
    expect(res.rows[0][3]).toBe("—");
  });

  it("registry exposes 23 presets across 8 categories", () => {
    const all = listPresets();
    expect(all.length).toBe(23);
    expect(new Set(all.map((p) => p.category)).size).toBe(8);
    for (const p of all) {
      expect(REPORT_PRESETS[p.key]).toBe(p);
      expect(p.fields.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("rejects unknown report keys with a stable code", () => {
    try {
      getPreset("nope");
      expect.unreachable();
    } catch (e) {
      expect((e as UserError).code).toBe("UNKNOWN_REPORT");
    }
  });
});

describe("16.6 saved-report tenant isolation", () => {
  const otherUser = crypto.randomUUID();

  async function save(cid: string, uid: string, name: string) {
    const now = new Date();
    const id = crypto.randomUUID();
    await db.insert(s.savedReports).values({
      id, companyId: cid, userId: uid, name, reportKey: "trial-balance",
      paramsJson: JSON.stringify(validateReportParams({ from: "2026-01-01", to: "2026-12-31" })),
      createdAt: now, updatedAt: now,
    });
    return id;
  }

  it("scopes reads to company + user", async () => {
    const mine = await save(companyId, userId, "mine");
    await save(companyId, otherUser, "theirs");
    await save(otherCompanyId, userId, "other-co");
    const rows = await db
      .select()
      .from(s.savedReports)
      .where(and(eq(s.savedReports.companyId, companyId), eq(s.savedReports.userId, userId)));
    expect(rows.map((r) => r.id)).toEqual([mine]);
    // stored params survive a validate round-trip
    expect(validateReportParams(JSON.parse(rows[0].paramsJson)).from).toBe("2026-01-01");
  });

  it("update/delete match on id + company + user (no cross-tenant write)", async () => {
    const id = await save(companyId, userId, "todelete");
    // wrong user deletes nothing
    await db
      .delete(s.savedReports)
      .where(and(eq(s.savedReports.id, id), eq(s.savedReports.companyId, companyId), eq(s.savedReports.userId, otherUser)));
    const still = await db.select().from(s.savedReports).where(eq(s.savedReports.id, id));
    expect(still).toHaveLength(1);
    // rightful owner deletes
    await db
      .delete(s.savedReports)
      .where(and(eq(s.savedReports.id, id), eq(s.savedReports.companyId, companyId), eq(s.savedReports.userId, userId)));
    const gone = await db.select().from(s.savedReports).where(eq(s.savedReports.id, id));
    expect(gone).toHaveLength(0);
  });
});
