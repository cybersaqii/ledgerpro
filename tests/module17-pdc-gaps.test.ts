/**
 * Module 17 — PDC gaps: bounce fee journals (both kinds), due-for-clearing
 * auto-suggest, idempotent record, pdc-aging preset buckets, and the
 * guard rails (no fee on cancel, no negative fee).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { recordPdc, bouncePdc, cancelPdc, duePdcCheques } from "@/lib/pdc";
import { getPreset } from "@/lib/report-presets";
import { validateReportParams } from "@/lib/report-engine";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let supplierId = "";

const D = (iso: string) => new Date(`${iso}T12:00:00Z`);

async function balanceOf(partyId: string): Promise<bigint> {
  const rows = await db
    .select({ balance: s.parties.balance })
    .from(s.parties)
    .where(eq(s.parties.id, partyId))
    .limit(1);
  return rows[0]!.balance;
}

/** Sum of journal lines for an account on entries with the given source. */
async function sumFor(accountCode: string, source: string): Promise<{ debit: bigint; credit: bigint }> {
  const ac = await accountMap(db, companyId);
  const acctId = ac[accountCode as keyof typeof ac];
  const lines = await db
    .select({ debit: s.journalLines.debit, credit: s.journalLines.credit, source: s.journalEntries.source })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalLines.accountId, acctId)));
  let debit = 0n;
  let credit = 0n;
  for (const l of lines) {
    if (l.source !== source) continue;
    debit += l.debit;
    credit += l.credit;
  }
  return { debit, credit };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "PDC Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  customerId = crypto.randomUUID();
  supplierId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: customerId, companyId, kind: "CUSTOMER", name: "PDC Customer" },
    { id: supplierId, companyId, kind: "SUPPLIER", name: "PDC Supplier" },
  ]);
});

afterAll(() => cleanup());

describe("bounce fee journals", () => {
  it("RECEIVED: fee is Dr AR / Cr Bounce income and grows the customer balance", async () => {
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customerId,
        chequeNo: "RCV-1001", amount: 100000n, chequeDate: D("2026-09-01"), createdById: userId,
      })
    );
    expect(await balanceOf(customerId)).toBe(-100000n); // record moved it toward us
    await db.transaction((tx) =>
      bouncePdc(tx, { pdcId, companyId, branchId, date: D("2026-10-01"), createdById: userId, bounceFee: 500n })
    );
    // bounce restores the 100,000 and the fee adds 500 on top
    expect(await balanceOf(customerId)).toBe(500n);
    const ar = await sumFor(SYS.AR, "PDC_BOUNCE_FEE");
    expect(ar.debit).toBe(500n);
    expect(ar.credit).toBe(0n);
    const inc = await sumFor(SYS.BOUNCE_INCOME, "PDC_BOUNCE_FEE");
    expect(inc.credit).toBe(500n);
    expect(inc.debit).toBe(0n);
  });

  it("ISSUED: fee is Dr Bounce expense / Cr AP and grows the supplier balance", async () => {
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "ISSUED", partyId: supplierId,
        chequeNo: "ISS-2001", amount: 50000n, chequeDate: D("2026-09-01"), createdById: userId,
      })
    );
    expect(await balanceOf(supplierId)).toBe(-50000n);
    await db.transaction((tx) =>
      bouncePdc(tx, { pdcId, companyId, branchId, date: D("2026-10-01"), createdById: userId, bounceFee: 750n })
    );
    expect(await balanceOf(supplierId)).toBe(750n);
    const exp = await sumFor(SYS.BOUNCE_EXPENSE, "PDC_BOUNCE_FEE");
    expect(exp.debit).toBe(750n);
    const ap = await sumFor(SYS.AP, "PDC_BOUNCE_FEE");
    expect(ap.credit).toBe(750n);
  });

  it("rejects a fee on cancel (FEE_ON_CANCEL)", async () => {
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customerId,
        chequeNo: "RCV-1002", amount: 10000n, chequeDate: D("2026-09-01"), createdById: userId,
      })
    );
    await expect(
      db.transaction((tx) =>
        cancelPdc(tx, { pdcId, companyId, branchId, date: D("2026-10-01"), createdById: userId, bounceFee: 100n })
      )
    ).rejects.toMatchObject({ code: "FEE_ON_CANCEL" });
  });

  it("rejects a negative fee (NEGATIVE_BOUNCE_FEE)", async () => {
    const pdcId = await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customerId,
        chequeNo: "RCV-1003", amount: 10000n, chequeDate: D("2026-09-01"), createdById: userId,
      })
    );
    await expect(
      db.transaction((tx) =>
        bouncePdc(tx, { pdcId, companyId, branchId, date: D("2026-10-01"), createdById: userId, bounceFee: -50n })
      )
    ).rejects.toMatchObject({ code: "NEGATIVE_BOUNCE_FEE" });
  });
});

describe("due-for-clearing auto-suggest", () => {
  it("returns only PENDING cheques with chequeDate <= asOf, oldest first", async () => {
    const mk = (no: string, iso: string, kind: "RECEIVED" | "ISSUED" = "RECEIVED") =>
      db.transaction((tx) =>
        recordPdc(tx, {
          companyId, branchId, kind, partyId: kind === "RECEIVED" ? customerId : supplierId,
          chequeNo: no, amount: 1000n, chequeDate: D(iso), createdById: userId,
        })
      );
    const oldId = await mk("DUE-001", "2026-09-10");
    const newerId = await mk("DUE-002", "2026-09-20");
    const futureId = await mk("DUE-003", "2026-11-15");
    void futureId;
    const due = await duePdcCheques(db, companyId, D("2026-10-01"));
    const ids = due.map((d) => d.id);
    expect(ids).toContain(oldId);
    expect(ids).toContain(newerId);
    expect(ids).not.toContain(futureId);
    expect(ids.indexOf(oldId)).toBeLessThan(ids.indexOf(newerId)); // oldest first
    // every row is actionable now
    for (const d of due) {
      expect(d.chequeDate.getTime()).toBeLessThanOrEqual(D("2026-10-01").getTime());
    }
  });
});

describe("idempotent record", () => {
  it("the partial unique index rejects a second row with the same key", async () => {
    const key = `idem-${crypto.randomUUID()}`;
    await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customerId,
        chequeNo: "IDEM-1", amount: 5000n, chequeDate: D("2026-09-01"),
        createdById: userId, idempotencyKey: key,
      })
    );
    await expect(
      db.transaction((tx) =>
        recordPdc(tx, {
          companyId, branchId, kind: "RECEIVED", partyId: customerId,
          chequeNo: "IDEM-1", amount: 5000n, chequeDate: D("2026-09-01"),
          createdById: userId, idempotencyKey: key,
        })
      )
    ).rejects.toThrow(); // UNIQUE constraint on (company_id, idempotency_key)
    const rows = await db
      .select({ id: s.pdcCheques.id })
      .from(s.pdcCheques)
      .where(and(eq(s.pdcCheques.companyId, companyId), eq(s.pdcCheques.idempotencyKey, key)));
    expect(rows).toHaveLength(1);
  });
});

describe("pdc-aging preset", () => {
  it("is registered as a non-PRO cash/bank report with basic permission", () => {
    const p = getPreset("pdc-aging");
    expect(p.category).toBe("cashbank");
    expect(p.perm).toBe("reports_basic");
    expect(p.pro).toBe(false);
  });

  it("buckets PENDING cheques by days past cheque date (Received vs Issued rows)", async () => {
    const mk = (no: string, iso: string, kind: "RECEIVED" | "ISSUED", amount: bigint) =>
      db.transaction((tx) =>
        recordPdc(tx, {
          companyId, branchId, kind, partyId: kind === "RECEIVED" ? customerId : supplierId,
          chequeNo: no, amount, chequeDate: D(iso), createdById: userId,
        })
      );
    // 40 days overdue → 31–60 bucket; 5 days overdue → 1–30 bucket.
    // (Other tests in this file also leave PENDING cheques, so assert >=.)
    const overdue40 = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
    const overdue5 = new Date(Date.now() - 5 * 86400000).toISOString().slice(0, 10);
    await mk("AGE-101", overdue40, "RECEIVED", 20000n);
    await mk("AGE-102", overdue5, "ISSUED", 30000n);

    const preset = getPreset("pdc-aging");
    const res = await preset.run({
      db, companyId, fyStart: "07-01",
      params: validateReportParams({}),
    });
    // row = [label, count, notDue, d30, d60, d90, d90plus, total] (paisa strings)
    expect(res.columns.map((c) => c.key)).toEqual(
      ["kind", "count", "notDue", "d30", "d60", "d90", "d90plus", "total"]
    );
    const byLabel = new Map(res.rows.map((r) => [String(r[0]), r]));
    const received = byLabel.get("Received")!;
    const issued = byLabel.get("Issued")!;
    expect(BigInt(String(received[4]))).toBeGreaterThanOrEqual(20000n); // 40d → 31–60
    expect(BigInt(String(issued[3]))).toBeGreaterThanOrEqual(30000n); // 5d → 1–30
    expect(BigInt(String(received[7]))).toBeGreaterThanOrEqual(20000n);
    expect(BigInt(String(issued[7]))).toBeGreaterThanOrEqual(30000n);
    // grand totals cover every pending cheque in the company
    const pendingTotal = res.totals!.find((x) => x.label === "Pending total");
    expect(BigInt(pendingTotal!.value)).toBeGreaterThanOrEqual(50000n);
  });
});
