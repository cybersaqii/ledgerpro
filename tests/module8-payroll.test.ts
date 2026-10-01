import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS } from "@/lib/setup";
import { parseMoney } from "@/lib/money";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";
import {
  annualIncomeTaxPaisa,
  monthlyIncomeTaxPaisa,
  eobiSplit,
  pctOf,
  computeSlipMath,
  DEFAULT_TAX_SLABS,
  createPayrollRun,
  updateSlipPayableDays,
  postPayrollRun,
  voidPayrollRun,
  disbursePayrollRun,
  issueEmployeeAdvance,
  bankAdviceCsv,
  getPayrollSettings,
  listTaxSlabs,
} from "@/lib/payroll";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let bankId = "";
let empA = ""; // permanent, monthly 100,000
let empB = ""; // daily wage, 2,000/day

const R = (rs: number) => BigInt(rs) * 100n; // rupees → paisa

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await setupCompany(db, companyId);
  const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId)).limit(1);
  bankId = ba.id;

  empA = crypto.randomUUID();
  empB = crypto.randomUUID();
  const d = new Date("2026-01-05T12:00:00Z");
  await db.insert(s.employees).values([
    {
      id: empA, companyId, code: "EMP-001", fullName: "Ali Raza",
      joiningDate: d, employmentType: "PERMANENT",
      baseSalaryPaisa: R(100000), basicPaisa: R(60000), hraPaisa: R(20000),
      medicalPaisa: R(10000), conveyancePaisa: R(5000), specialAllowancePaisa: R(5000),
      createdById: userId,
    },
    {
      id: empB, companyId, code: "EMP-002", fullName: "Bilal Khan",
      joiningDate: d, employmentType: "DAILY_WAGE",
      baseSalaryPaisa: R(2000), basicPaisa: 0n,
      createdById: userId,
    },
  ]);
});

afterAll(() => cleanup());

async function journalSums(journalEntryId: string): Promise<{ dr: bigint; cr: bigint }> {
  const lines = await db
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.entryId, journalEntryId));
  let dr = 0n, cr = 0n;
  for (const l of lines) { dr += BigInt(l.debit); cr += BigInt(l.credit); }
  return { dr, cr };
}

async function acctBalancePaisa(code: string): Promise<bigint> {
  const [a] = await db
    .select({ id: s.accounts.id })
    .from(s.accounts)
    .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code)))
    .limit(1);
  const lines = await db
    .select()
    .from(s.journalLines)
    .where(eq(s.journalLines.accountId, a.id));
  let bal = 0n;
  for (const l of lines) bal += BigInt(l.debit) - BigInt(l.credit);
  return bal;
}

describe("Module 8: pure salary math", () => {
  it("income-tax slab boundaries (Pakistan salaried defaults)", () => {
    expect(annualIncomeTaxPaisa(R(600000), DEFAULT_TAX_SLABS)).toBe(0n);
    expect(annualIncomeTaxPaisa(R(700000), DEFAULT_TAX_SLABS)).toBe(R(1000)); // 1% of 100k
    expect(annualIncomeTaxPaisa(R(1200000), DEFAULT_TAX_SLABS)).toBe(R(6000));
    expect(annualIncomeTaxPaisa(R(1500000), DEFAULT_TAX_SLABS)).toBe(R(39000)); // 6k + 11% of 300k
    expect(annualIncomeTaxPaisa(R(2200000), DEFAULT_TAX_SLABS)).toBe(R(116000));
    expect(annualIncomeTaxPaisa(R(3200000), DEFAULT_TAX_SLABS)).toBe(R(346000));
    expect(annualIncomeTaxPaisa(R(4100000), DEFAULT_TAX_SLABS)).toBe(R(616000));
    expect(annualIncomeTaxPaisa(R(5000000), DEFAULT_TAX_SLABS)).toBe(R(616000 + 315000)); // +35% of 900k
    expect(annualIncomeTaxPaisa(0n, DEFAULT_TAX_SLABS)).toBe(0n);
  });

  it("monthly tax = annual tax / 12", () => {
    // 100k/month → 1.2M annual → 6,000/yr → 500/month
    expect(monthlyIncomeTaxPaisa(R(100000), DEFAULT_TAX_SLABS)).toBe(R(500));
    // 50k/month → 600k annual → 0
    expect(monthlyIncomeTaxPaisa(R(50000), DEFAULT_TAX_SLABS)).toBe(0n);
  });

  it("EOBI split respects the wage cap", () => {
    const r = eobiSplit(R(50000), 100, 500, R(37000));
    expect(r.employee).toBe(R(370));
    expect(r.employer).toBe(R(1850));
    const low = eobiSplit(R(20000), 100, 500, R(37000));
    expect(low.employee).toBe(R(200));
  });

  it("pctOf floors to the paisa", () => {
    expect(pctOf(999n, 10000)).toBe(999n);
    expect(pctOf(1n, 1)).toBe(0n);
  });

  it("slip math: pro-rated components always sum to gross, tax nets correctly", () => {
    const m = computeSlipMath({
      employmentType: "PERMANENT", baseSalaryPaisa: R(100000),
      basicPaisa: R(60000), hraPaisa: R(20000), medicalPaisa: R(10000),
      conveyancePaisa: R(5000), specialAllowancePaisa: R(5000),
      payableDays: 28, workDaysPerMonth: 30, advanceBalancePaisa: 0n,
      eobiEmployeeBps: 100, eobiEmployerBps: 500, eobiWageCapPaisa: R(37000),
      pfEmployeeBps: 0, pfEmployerBps: 0, taxSlabs: DEFAULT_TAX_SLABS,
    });
    expect(m.basicPaisa + m.hraPaisa + m.medicalPaisa + m.conveyancePaisa + m.specialAllowancePaisa).toBe(m.grossPaisa);
    expect(m.grossPaisa).toBe((R(100000) * 28n) / 30n);
    // 93,333.33/month annualises to 1.12M → 1% of 520k = 5,200/yr → 433.33/mo → 433
    expect(m.taxPaisa).toBe(monthlyIncomeTaxPaisa(m.grossPaisa, DEFAULT_TAX_SLABS));
    expect(m.netPaisa).toBe(m.grossPaisa - m.taxPaisa - m.eobiEmployeePaisa - m.pfEmployeePaisa - m.advancePaisa);
    expect(m.eobiEmployeePaisa).toBe(R(370)); // capped wages
    expect(m.eobiEmployerPaisa).toBe(R(1850));
  });

  it("daily-wage: gross = daily rate × payable days, booked to basic", () => {
    const m = computeSlipMath({
      employmentType: "DAILY_WAGE", baseSalaryPaisa: R(2000),
      basicPaisa: 0n, hraPaisa: 0n, medicalPaisa: 0n, conveyancePaisa: 0n, specialAllowancePaisa: 0n,
      payableDays: 25, workDaysPerMonth: 30, advanceBalancePaisa: 0n,
      eobiEmployeeBps: 100, eobiEmployerBps: 500, eobiWageCapPaisa: R(37000),
      pfEmployeeBps: 0, pfEmployerBps: 0, taxSlabs: DEFAULT_TAX_SLABS,
    });
    expect(m.grossPaisa).toBe(R(50000));
    expect(m.basicPaisa).toBe(R(50000));
    expect(m.eobiEmployeePaisa).toBe(0n); // daily wagers excluded from EOBI
    expect(m.netPaisa).toBe(m.grossPaisa - m.taxPaisa);
  });

  it("advance knock-off is capped at net-before-advance", () => {
    const m = computeSlipMath({
      employmentType: "PERMANENT", baseSalaryPaisa: R(100000),
      basicPaisa: R(100000), hraPaisa: 0n, medicalPaisa: 0n, conveyancePaisa: 0n, specialAllowancePaisa: 0n,
      payableDays: 30, workDaysPerMonth: 30, advanceBalancePaisa: R(999999),
      eobiEmployeeBps: 100, eobiEmployerBps: 500, eobiWageCapPaisa: R(37000),
      pfEmployeeBps: 0, pfEmployerBps: 0, taxSlabs: DEFAULT_TAX_SLABS,
    });
    const preAdvance = m.grossPaisa - m.taxPaisa - m.eobiEmployeePaisa;
    expect(m.advancePaisa).toBe(preAdvance);
    expect(m.netPaisa).toBe(0n);
  });
});

describe("Module 8: SYS accounts + seeded config", () => {
  it("setupCompany creates the payroll system accounts", async () => {
    for (const code of [
      SYS.EMPLOYEE_ADVANCES, SYS.SALARIES_PAYABLE, SYS.SALARY_TAX_PAYABLE,
      SYS.EOBI_PAYABLE, SYS.PF_PAYABLE, SYS.SALARIES_WAGES_EXPENSE, SYS.EMPLOYER_CONTRIB_EXPENSE,
    ]) {
      const rows = await db
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, code)));
      expect(rows.length, `account ${code}`).toBe(1);
    }
  });

  it("migration seeds payroll settings and the default tax slabs", async () => {
    const st = await getPayrollSettings(db, companyId);
    expect(st.workDaysPerMonth).toBe(30);
    expect(st.eobiEmployeeBps).toBe(100);
    const slabs = await listTaxSlabs(db, companyId);
    expect(slabs.length).toBe(6);
    expect(slabs[0]!.minAnnualPaisa).toBe(0n);
    expect(slabs[5]!.maxAnnualPaisa).toBeNull();
  });
});

describe("Module 8: advances + payroll run lifecycle", () => {
  let runId = "";

  it("issue advance: Dr 1130 / Cr bank, balance cache drops", async () => {
    const [before] = await db.select({ balance: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
    const { id } = await db.transaction((tx) =>
      issueEmployeeAdvance(tx, {
        companyId, employeeId: empA, amountPaisa: R(20000),
        date: new Date("2026-09-05T12:00:00Z"), bankAccountId: bankId,
        note: "test advance", createdById: userId,
      })
    );
    const [adv] = await db.select().from(s.employeeAdvances).where(eq(s.employeeAdvances.id, id)).limit(1);
    expect(adv.status).toBe("OPEN");
    expect(BigInt(adv.balancePaisa)).toBe(R(20000));
    const { dr, cr } = await journalSums(adv.journalEntryId!);
    expect(dr).toBe(cr);
    expect(dr).toBe(R(20000));
    // GL: 1130 debited 20k
    expect(await acctBalancePaisa(SYS.EMPLOYEE_ADVANCES)).toBe(R(20000));
    const [after] = await db.select({ balance: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
    expect(BigInt(after.balance)).toBe(BigInt(before.balance) - R(20000));
  });

  it("creates a DRAFT run with snapshot slips", async () => {
    runId = await db.transaction((tx) => createPayrollRun(tx, { companyId, year: 2026, month: 9, createdById: userId }));
    const [run] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId)).limit(1);
    expect(run.status).toBe("DRAFT");
    expect(run.docNo).toMatch(/^PR-202609-/);
    const slips = await db.select().from(s.payrollSlips).where(eq(s.payrollSlips.runId, runId));
    expect(slips.length).toBe(2); // both active employees
    const a = slips.find((x) => x.employeeId === empA)!;
    // Advance knocked off inside the draft slip
    expect(BigInt(a.advancePaisa)).toBe(R(20000));
    const b = slips.find((x) => x.employeeId === empB)!;
    expect(BigInt(b.grossPaisa)).toBe(R(60000)); // 2,000 × 30 days
  });

  it("double run for the same period is blocked", async () => {
    await expect(
      db.transaction((tx) => createPayrollRun(tx, { companyId, year: 2026, month: 9, createdById: userId }))
    ).rejects.toThrow(/already exists/);
  });

  it("payable-days edit recomputes the slip (unpaid leaves)", async () => {
    const slips = await db.select().from(s.payrollSlips).where(eq(s.payrollSlips.runId, runId));
    const a = slips.find((x) => x.employeeId === empA)!;
    await db.transaction((tx) =>
      updateSlipPayableDays(tx, { companyId, runId, items: [{ slipId: a.id, payableDays: 27 }] })
    );
    const [upd] = await db.select().from(s.payrollSlips).where(eq(s.payrollSlips.id, a.id)).limit(1);
    expect(upd.payableDays).toBe(27);
    expect(BigInt(upd.grossPaisa)).toBe((R(100000) * 27n) / 30n);
    expect(BigInt(upd.basicPaisa) + BigInt(upd.hraPaisa) + BigInt(upd.medicalPaisa) + BigInt(upd.conveyancePaisa) + BigInt(upd.specialAllowancePaisa))
      .toBe(BigInt(upd.grossPaisa));
  });

  it("Approve & Post: one balanced journal, correct lines, advances cleared", async () => {
    const { journalEntryId } = await db.transaction((tx) => postPayrollRun(tx, { companyId, runId, createdById: userId }));
    const [run] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId)).limit(1);
    expect(run.status).toBe("POSTED");
    expect(run.journalEntryId).toBe(journalEntryId);

    const { dr, cr } = await journalSums(journalEntryId);
    expect(dr).toBe(cr);
    expect(dr).toBeGreaterThan(0n);
    // Dr == gross + employer contributions; Cr == everything else; net lands on 2119.
    expect(dr).toBe(BigInt(run.grossPaisa) + BigInt(run.eobiEmployerPaisa) + BigInt(run.pfEmployerPaisa));
    expect(await acctBalancePaisa(SYS.SALARIES_PAYABLE)).toBe(-BigInt(run.netPaisa)); // credit balance
    expect(await acctBalancePaisa(SYS.SALARY_TAX_PAYABLE)).toBe(-BigInt(run.taxPaisa));
    expect(await acctBalancePaisa(SYS.EMPLOYEE_ADVANCES)).toBe(0n); // knocked off fully

    const advs = await db.select().from(s.employeeAdvances).where(eq(s.employeeAdvances.companyId, companyId));
    expect(advs.every((a) => a.status === "CLEARED")).toBe(true);

    // Journal carries the deterministic idempotency key.
    const [je] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, journalEntryId)).limit(1);
    expect(je.idempotencyKey).toBe(`payroll-run:${runId}`);
  });

  it("repost is blocked (no double journal)", async () => {
    await expect(
      db.transaction((tx) => postPayrollRun(tx, { companyId, runId, createdById: userId }))
    ).rejects.toThrow(/only drafts can be posted/);
    const jes = await db.select().from(s.journalEntries)
      .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "PAYROLL")));
    expect(jes.length).toBe(1);
  });

  it("bank advice CSV lists every slip", async () => {
    const rows = [
      { code: "EMP-001", name: "Ali Raza", bankAccountNo: "123", netPaisa: R(79500), month: "2026-09" },
      { code: "EMP-002", name: "Bilal Khan", bankAccountNo: "", netPaisa: R(60000), month: "2026-09" },
    ];
    const csv = bankAdviceCsv(rows);
    expect(csv.split("\n").length).toBe(3);
    expect(csv).toContain("EMP-001");
    expect(csv).toContain("79500.00");
  });

  it("disburse: Dr 2119 / Cr bank, run → PAID, bank balance drops", async () => {
    const [before] = await db.select({ balance: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
    const [run0] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId)).limit(1);
    const { journalEntryId } = await db.transaction((tx) =>
      disbursePayrollRun(tx, { companyId, runId, bankAccountId: bankId, date: new Date("2026-09-30T12:00:00Z"), createdById: userId })
    );
    const { dr, cr } = await journalSums(journalEntryId);
    expect(dr).toBe(cr);
    expect(dr).toBe(BigInt(run0.netPaisa));
    expect(await acctBalancePaisa(SYS.SALARIES_PAYABLE)).toBe(0n);
    const [after] = await db.select({ balance: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
    expect(BigInt(after.balance)).toBe(BigInt(before.balance) - BigInt(run0.netPaisa));
    const [run] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, runId)).limit(1);
    expect(run.status).toBe("PAID");
  });

  it("void after disbursement is blocked; void on a posted run reverses everything", async () => {
    // PAID run cannot be voided.
    await expect(
      db.transaction((tx) => voidPayrollRun(tx, { companyId, runId, createdById: userId }))
    ).rejects.toThrow(/Only posted runs can be voided/);

    // Fresh run → post → void.
    const run2 = await db.transaction((tx) => createPayrollRun(tx, { companyId, year: 2026, month: 10, createdById: userId }));
    const { journalEntryId } = await db.transaction((tx) => postPayrollRun(tx, { companyId, runId: run2, createdById: userId }));
    const { reversingJournalEntryId } = await db.transaction((tx) => voidPayrollRun(tx, { companyId, runId: run2, createdById: userId }));

    const { dr, cr } = await journalSums(reversingJournalEntryId);
    expect(dr).toBe(cr);
    const { dr: odr, cr: ocr } = await journalSums(journalEntryId);
    expect(dr).toBe(odr);
    expect(cr).toBe(ocr);

    const [r2] = await db.select().from(s.payrollRuns).where(eq(s.payrollRuns.id, run2)).limit(1);
    expect(r2.status).toBe("VOIDED");

    // Ledger nets to zero for the voided run's postings: check via 2119 —
    // after the reversal the October run must not leave a payable.
    // (September's run was disbursed, so 2119 is 0 overall.)
    expect(await acctBalancePaisa(SYS.SALARIES_PAYABLE)).toBe(0n);
  });

  it("slip edits are blocked once posted", async () => {
    const run3 = await db.transaction((tx) => createPayrollRun(tx, { companyId, year: 2026, month: 11, createdById: userId }));
    await db.transaction((tx) => postPayrollRun(tx, { companyId, runId: run3, createdById: userId }));
    const slips = await db.select().from(s.payrollSlips).where(eq(s.payrollSlips.runId, run3));
    await expect(
      db.transaction((tx) => updateSlipPayableDays(tx, { companyId, runId: run3, items: [{ slipId: slips[0]!.id, payableDays: 1 }] }))
    ).rejects.toThrow(/Only draft runs can be edited/);
  });

  it("parseMoney rejects garbage for employee salary input", async () => {
    expect(() => parseMoney("abc")).toThrow(UserError);
  });
});
