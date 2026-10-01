// Module 8: Payroll & HRM.
//
// Pure, unit-testable salary math (income-tax slabs, EOBI, PF, net pay) plus
// the transactional payroll-run operations: create → edit payable days →
// Approve & Post (one balanced journal per run) → void (reversing journal) →
// bank disbursement.
//
// Money is integer paisa / BigInt everywhere. Every query is scoped to
// company_id.

import { eq, and, asc, inArray, sql } from "drizzle-orm";
import {
  employees,
  payrollRuns,
  payrollSlips,
  employeeAdvances,
  payrollSettings,
  payrollTaxSlabs,
  bankAccounts,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

// ─── Pure salary math ────────────────────────────────────────────────

export type TaxSlabInput = {
  minAnnualPaisa: bigint;
  maxAnnualPaisa: bigint | null;
  rateBps: number; // marginal rate on (annualGross - min)
  fixedPaisa: bigint; // tax due exactly at minAnnualPaisa
};

/** Pakistan monthly salary slabs ship as defaults (FY2025-26, annual bounds).
 *  Companies can edit them under Settings → Payroll. NOT tax advice. */
export const DEFAULT_TAX_SLABS: TaxSlabInput[] = [
  { minAnnualPaisa: 0n, maxAnnualPaisa: 60_000_000n, rateBps: 0, fixedPaisa: 0n },
  { minAnnualPaisa: 60_000_000n, maxAnnualPaisa: 120_000_000n, rateBps: 100, fixedPaisa: 0n },
  { minAnnualPaisa: 120_000_000n, maxAnnualPaisa: 220_000_000n, rateBps: 1100, fixedPaisa: 600_000n },
  { minAnnualPaisa: 220_000_000n, maxAnnualPaisa: 320_000_000n, rateBps: 2300, fixedPaisa: 11_600_000n },
  { minAnnualPaisa: 320_000_000n, maxAnnualPaisa: 410_000_000n, rateBps: 3000, fixedPaisa: 34_600_000n },
  { minAnnualPaisa: 410_000_000n, maxAnnualPaisa: null, rateBps: 3500, fixedPaisa: 61_600_000n },
];

export function pctOf(amountPaisa: bigint, bps: number): bigint {
  if (bps <= 0 || amountPaisa <= 0n) return 0n;
  return (amountPaisa * BigInt(bps)) / 10000n;
}

/** Annual income tax on annualised gross salary, via marginal slabs. */
export function annualIncomeTaxPaisa(annualGrossPaisa: bigint, slabs: TaxSlabInput[]): bigint {
  if (annualGrossPaisa <= 0n) return 0n;
  const sorted = [...slabs].sort((a, b) =>
    a.minAnnualPaisa < b.minAnnualPaisa ? -1 : a.minAnnualPaisa > b.minAnnualPaisa ? 1 : 0
  );
  for (const s of sorted) {
    const inSlab =
      annualGrossPaisa >= s.minAnnualPaisa &&
      (s.maxAnnualPaisa === null || annualGrossPaisa <= s.maxAnnualPaisa);
    if (inSlab) {
      const excess = annualGrossPaisa - s.minAnnualPaisa;
      return s.fixedPaisa + (excess * BigInt(s.rateBps)) / 10000n;
    }
  }
  return 0n;
}

/** Monthly tax = annual tax on (monthly gross × 12), divided by 12 (floor). */
export function monthlyIncomeTaxPaisa(monthlyGrossPaisa: bigint, slabs: TaxSlabInput[]): bigint {
  if (monthlyGrossPaisa <= 0n) return 0n;
  return annualIncomeTaxPaisa(monthlyGrossPaisa * 12n, slabs) / 12n;
}

/** EOBI split on insurable wages (capped). Returns { employee, employer }. */
export function eobiSplit(
  wagePaisa: bigint,
  employeeBps: number,
  employerBps: number,
  capPaisa: bigint
): { employee: bigint; employer: bigint } {
  const base = wagePaisa < capPaisa ? wagePaisa : capPaisa;
  return { employee: pctOf(base, employeeBps), employer: pctOf(base, employerBps) };
}

export type SlipMathInput = {
  employmentType: string; // PERMANENT | CONTRACT | DAILY_WAGE
  baseSalaryPaisa: bigint; // monthly salary, or daily rate for DAILY_WAGE
  basicPaisa: bigint;
  hraPaisa: bigint;
  medicalPaisa: bigint;
  conveyancePaisa: bigint;
  specialAllowancePaisa: bigint;
  payableDays: number;
  workDaysPerMonth: number;
  advanceBalancePaisa: bigint; // total open advance balance to knock off (FIFO)
  eobiEmployeeBps: number;
  eobiEmployerBps: number;
  eobiWageCapPaisa: bigint;
  pfEmployeeBps: number;
  pfEmployerBps: number;
  taxSlabs: TaxSlabInput[];
};

export type SlipMath = {
  basicPaisa: bigint;
  hraPaisa: bigint;
  medicalPaisa: bigint;
  conveyancePaisa: bigint;
  specialAllowancePaisa: bigint;
  grossPaisa: bigint;
  taxPaisa: bigint;
  eobiEmployeePaisa: bigint;
  eobiEmployerPaisa: bigint;
  pfEmployeePaisa: bigint;
  pfEmployerPaisa: bigint;
  advancePaisa: bigint;
  netPaisa: bigint;
};

/** Full slip computation. DAILY_WAGE: gross = daily rate × payable days
 *  (booked to Basic). Others: earnings pro-rated by payable/work days. */
export function computeSlipMath(input: SlipMathInput): SlipMath {
  const workDays = Math.max(1, input.workDaysPerMonth);
  const days = Math.max(0, Math.min(workDays, input.payableDays));
  const daily = input.employmentType === "DAILY_WAGE";

  let basic = 0n,
    hra = 0n,
    medical = 0n,
    conveyance = 0n,
    special = 0n,
    gross = 0n;
  if (daily) {
    gross = input.baseSalaryPaisa * BigInt(days);
    basic = gross;
  } else {
    const scale = (v: bigint) => (v * BigInt(days)) / BigInt(workDays);
    basic = scale(input.basicPaisa);
    hra = scale(input.hraPaisa);
    medical = scale(input.medicalPaisa);
    conveyance = scale(input.conveyancePaisa);
    special = scale(input.specialAllowancePaisa);
    gross = ((input.basicPaisa + input.hraPaisa + input.medicalPaisa + input.conveyancePaisa + input.specialAllowancePaisa) * BigInt(days)) / BigInt(workDays);
    // Rounding remainder goes to Basic so components always sum to gross.
    basic += gross - (basic + hra + medical + conveyance + special);
  }

  const tax = monthlyIncomeTaxPaisa(gross, input.taxSlabs);
  const eobi = daily
    ? { employee: 0n, employer: 0n }
    : eobiSplit(gross, input.eobiEmployeeBps, input.eobiEmployerBps, input.eobiWageCapPaisa);
  const pfEmployee = pctOf(basic, input.pfEmployeeBps);
  const pfEmployer = pctOf(basic, input.pfEmployerBps);

  const preAdvanceNet = gross - tax - eobi.employee - pfEmployee;
  const advance = preAdvanceNet > 0n && input.advanceBalancePaisa > 0n
    ? (input.advanceBalancePaisa < preAdvanceNet ? input.advanceBalancePaisa : preAdvanceNet)
    : 0n;
  const net = preAdvanceNet - advance;

  return {
    basicPaisa: basic, hraPaisa: hra, medicalPaisa: medical,
    conveyancePaisa: conveyance, specialAllowancePaisa: special,
    grossPaisa: gross, taxPaisa: tax,
    eobiEmployeePaisa: eobi.employee, eobiEmployerPaisa: eobi.employer,
    pfEmployeePaisa: pfEmployee, pfEmployerPaisa: pfEmployer,
    advancePaisa: advance, netPaisa: net,
  };
}

// ─── Settings & slabs ────────────────────────────────────────────────

export type PayrollSettingsRow = {
  eobiEmployeeBps: number;
  eobiEmployerBps: number;
  eobiWageCapPaisa: bigint;
  pfEmployeeBps: number;
  pfEmployerBps: number;
  workDaysPerMonth: number;
};

const DEFAULT_SETTINGS: PayrollSettingsRow = {
  eobiEmployeeBps: 100,
  eobiEmployerBps: 500,
  eobiWageCapPaisa: 3700000n,
  pfEmployeeBps: 0,
  pfEmployerBps: 0,
  workDaysPerMonth: 30,
};

/** Read the company's payroll settings, creating the default row if missing. */
export async function getPayrollSettings(tx: Db | DbTx, companyId: string): Promise<PayrollSettingsRow> {
  const [row] = await tx
    .select()
    .from(payrollSettings)
    .where(eq(payrollSettings.companyId, companyId))
    .limit(1);
  if (row) {
    return {
      eobiEmployeeBps: row.eobiEmployeeBps,
      eobiEmployerBps: row.eobiEmployerBps,
      eobiWageCapPaisa: BigInt(row.eobiWageCapPaisa),
      pfEmployeeBps: row.pfEmployeeBps,
      pfEmployerBps: row.pfEmployerBps,
      workDaysPerMonth: row.workDaysPerMonth,
    };
  }
  await tx.insert(payrollSettings).values({ companyId });
  return DEFAULT_SETTINGS;
}

export async function listTaxSlabs(tx: Db | DbTx, companyId: string): Promise<TaxSlabInput[]> {
  const rows = await tx
    .select()
    .from(payrollTaxSlabs)
    .where(eq(payrollTaxSlabs.companyId, companyId))
    .orderBy(asc(payrollTaxSlabs.sortOrder));
  if (rows.length === 0) return DEFAULT_TAX_SLABS;
  return rows.map((r) => ({
    minAnnualPaisa: BigInt(r.minAnnualPaisa),
    maxAnnualPaisa: r.maxAnnualPaisa === null ? null : BigInt(r.maxAnnualPaisa),
    rateBps: r.rateBps,
    fixedPaisa: BigInt(r.fixedPaisa),
  }));
}

/** Total OPEN/PARTIAL advance balance for an employee (FIFO order). */
export async function openAdvancesFor(
  tx: DbTx,
  companyId: string,
  employeeId: string
): Promise<{ id: string; balancePaisa: bigint }[]> {
  const rows = await tx
    .select({ id: employeeAdvances.id, balancePaisa: employeeAdvances.balancePaisa })
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.companyId, companyId),
        eq(employeeAdvances.employeeId, employeeId),
        inArray(employeeAdvances.status, ["OPEN", "PARTIAL"])
      )
    )
    .orderBy(asc(employeeAdvances.date), asc(employeeAdvances.createdAt));
  return rows.map((r) => ({ id: r.id, balancePaisa: BigInt(r.balancePaisa) }));
}

// ─── Payroll runs ────────────────────────────────────────────────────

export const RUN_STATUSES = ["DRAFT", "POSTED", "PAID", "VOIDED"] as const;

/** Last-day-of-month at UTC noon — the run's accounting date. */
export function runDateFor(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0));
}

async function loadRunForWrite(tx: DbTx, companyId: string, runId: string) {
  const [run] = await tx
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.companyId, companyId)))
    .limit(1);
  if (!run) throw new UserError("Payroll run not found", 422, "RUN_NOT_FOUND");
  return run;
}

async function recomputeRunTotals(tx: DbTx, runId: string): Promise<void> {
  const agg = await tx
    .select({
      gross: sql<bigint>`COALESCE(SUM(${payrollSlips.grossPaisa}), 0)`,
      tax: sql<bigint>`COALESCE(SUM(${payrollSlips.taxPaisa}), 0)`,
      eobiEmp: sql<bigint>`COALESCE(SUM(${payrollSlips.eobiEmployeePaisa}), 0)`,
      eobiEr: sql<bigint>`COALESCE(SUM(${payrollSlips.eobiEmployerPaisa}), 0)`,
      pfEmp: sql<bigint>`COALESCE(SUM(${payrollSlips.pfEmployeePaisa}), 0)`,
      pfEr: sql<bigint>`COALESCE(SUM(${payrollSlips.pfEmployerPaisa}), 0)`,
      adv: sql<bigint>`COALESCE(SUM(${payrollSlips.advancePaisa}), 0)`,
      net: sql<bigint>`COALESCE(SUM(${payrollSlips.netPaisa}), 0)`,
    })
    .from(payrollSlips)
    .where(eq(payrollSlips.runId, runId));
  const t = agg[0]!;
  await tx
    .update(payrollRuns)
    .set({
      grossPaisa: BigInt(t.gross), taxPaisa: BigInt(t.tax),
      eobiEmployeePaisa: BigInt(t.eobiEmp), eobiEmployerPaisa: BigInt(t.eobiEr),
      pfEmployeePaisa: BigInt(t.pfEmp), pfEmployerPaisa: BigInt(t.pfEr),
      advancePaisa: BigInt(t.adv), netPaisa: BigInt(t.net),
    })
    .where(eq(payrollRuns.id, runId));
}

/**
 * Create a DRAFT run for (year, month), snapshotting every active employee
 * into a slip with full payable days. Advances outstanding at creation are
 * knocked off FIFO inside each slip.
 */
export async function createPayrollRun(
  tx: DbTx,
  args: { companyId: string; year: number; month: number; createdById: string }
): Promise<string> {
  const { companyId, year, month, createdById } = args;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new UserError("Invalid year", 422, "INVALID_PERIOD");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new UserError("Invalid month", 422, "INVALID_PERIOD");

  const settings = await getPayrollSettings(tx, companyId);
  const slabs = await listTaxSlabs(tx, companyId);
  const active = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.companyId, companyId), eq(employees.isActive, true)));

  const runDate = runDateFor(year, month);
  const mm = String(month).padStart(2, "0");

  // Explicit guard first (the UNIQUE index is the backstop for races).
  const [dup] = await tx
    .select({ id: payrollRuns.id })
    .from(payrollRuns)
    .where(and(eq(payrollRuns.companyId, companyId), eq(payrollRuns.year, year), eq(payrollRuns.month, month)))
    .limit(1);
  if (dup) throw new UserError(`A payroll run already exists for ${year}-${mm}`, 422, "RUN_ALREADY_EXISTS");

  const runId = crypto.randomUUID();
  try {
    await tx.insert(payrollRuns).values({
      id: runId,
      companyId,
      year,
      month,
      status: "DRAFT",
      docNo: await nextDocNo(tx, companyId, "PAYROLL_RUN", `PR-${year}${mm}-`),
      runDate,
      createdById,
    });
  } catch (e) {
    if (/unique/i.test(String(e))) {
      throw new UserError(`A payroll run already exists for ${year}-${mm}`, 422, "RUN_ALREADY_EXISTS");
    }
    throw e;
  }

  for (const emp of active) {
    const advances = await openAdvancesFor(tx, companyId, emp.id);
    const advBalance = advances.reduce((a, x) => a + x.balancePaisa, 0n);
    const math = computeSlipMath({
      employmentType: emp.employmentType,
      baseSalaryPaisa: BigInt(emp.baseSalaryPaisa),
      basicPaisa: BigInt(emp.basicPaisa),
      hraPaisa: BigInt(emp.hraPaisa),
      medicalPaisa: BigInt(emp.medicalPaisa),
      conveyancePaisa: BigInt(emp.conveyancePaisa),
      specialAllowancePaisa: BigInt(emp.specialAllowancePaisa),
      payableDays: settings.workDaysPerMonth,
      workDaysPerMonth: settings.workDaysPerMonth,
      advanceBalancePaisa: advBalance,
      eobiEmployeeBps: settings.eobiEmployeeBps,
      eobiEmployerBps: settings.eobiEmployerBps,
      eobiWageCapPaisa: settings.eobiWageCapPaisa,
      pfEmployeeBps: settings.pfEmployeeBps,
      pfEmployerBps: settings.pfEmployerBps,
      taxSlabs: slabs,
    });
    await tx.insert(payrollSlips).values({
      id: crypto.randomUUID(),
      companyId,
      runId,
      employeeId: emp.id,
      employeeCode: emp.code,
      employeeName: emp.fullName,
      payableDays: settings.workDaysPerMonth,
      workDays: settings.workDaysPerMonth,
      basicPaisa: math.basicPaisa,
      hraPaisa: math.hraPaisa,
      medicalPaisa: math.medicalPaisa,
      conveyancePaisa: math.conveyancePaisa,
      specialAllowancePaisa: math.specialAllowancePaisa,
      grossPaisa: math.grossPaisa,
      taxPaisa: math.taxPaisa,
      eobiEmployeePaisa: math.eobiEmployeePaisa,
      eobiEmployerPaisa: math.eobiEmployerPaisa,
      pfEmployeePaisa: math.pfEmployeePaisa,
      pfEmployerPaisa: math.pfEmployerPaisa,
      advancePaisa: math.advancePaisa,
      netPaisa: math.netPaisa,
    });
  }
  await recomputeRunTotals(tx, runId);
  return runId;
}

/**
 * Edit payable days (unpaid leaves) on DRAFT slips; each slip is recomputed
 * and run totals refreshed.
 */
export async function updateSlipPayableDays(
  tx: DbTx,
  args: { companyId: string; runId: string; items: { slipId: string; payableDays: number }[] }
): Promise<void> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "DRAFT") throw new UserError("Only draft runs can be edited", 422, "RUN_NOT_DRAFT");

  const settings = await getPayrollSettings(tx, args.companyId);
  const slabs = await listTaxSlabs(tx, args.companyId);

  for (const item of args.items) {
    if (!Number.isInteger(item.payableDays) || item.payableDays < 0 || item.payableDays > settings.workDaysPerMonth) {
      throw new UserError(`Payable days must be 0–${settings.workDaysPerMonth}`, 422, "INVALID_PAYABLE_DAYS");
    }
    const [slip] = await tx
      .select()
      .from(payrollSlips)
      .where(
        and(
          eq(payrollSlips.id, item.slipId),
          eq(payrollSlips.runId, args.runId),
          eq(payrollSlips.companyId, args.companyId)
        )
      )
      .limit(1);
    if (!slip) throw new UserError("Slip not found in this run", 422, "SLIP_NOT_FOUND");
    const [emp] = await tx
      .select()
      .from(employees)
      .where(and(eq(employees.id, slip.employeeId), eq(employees.companyId, args.companyId)))
      .limit(1);
    if (!emp) throw new UserError("Employee not found", 422, "EMPLOYEE_NOT_FOUND");

    const advances = await openAdvancesFor(tx, args.companyId, emp.id);
    const advBalance = advances.reduce((a, x) => a + x.balancePaisa, 0n);
    const math = computeSlipMath({
      employmentType: emp.employmentType,
      baseSalaryPaisa: BigInt(emp.baseSalaryPaisa),
      basicPaisa: BigInt(emp.basicPaisa),
      hraPaisa: BigInt(emp.hraPaisa),
      medicalPaisa: BigInt(emp.medicalPaisa),
      conveyancePaisa: BigInt(emp.conveyancePaisa),
      specialAllowancePaisa: BigInt(emp.specialAllowancePaisa),
      payableDays: item.payableDays,
      workDaysPerMonth: settings.workDaysPerMonth,
      advanceBalancePaisa: advBalance,
      eobiEmployeeBps: settings.eobiEmployeeBps,
      eobiEmployerBps: settings.eobiEmployerBps,
      eobiWageCapPaisa: settings.eobiWageCapPaisa,
      pfEmployeeBps: settings.pfEmployeeBps,
      pfEmployerBps: settings.pfEmployerBps,
      taxSlabs: slabs,
    });
    await tx
      .update(payrollSlips)
      .set({
        payableDays: item.payableDays,
        workDays: settings.workDaysPerMonth,
        basicPaisa: math.basicPaisa,
        hraPaisa: math.hraPaisa,
        medicalPaisa: math.medicalPaisa,
        conveyancePaisa: math.conveyancePaisa,
        specialAllowancePaisa: math.specialAllowancePaisa,
        grossPaisa: math.grossPaisa,
        taxPaisa: math.taxPaisa,
        eobiEmployeePaisa: math.eobiEmployeePaisa,
        eobiEmployerPaisa: math.eobiEmployerPaisa,
        pfEmployeePaisa: math.pfEmployeePaisa,
        pfEmployerPaisa: math.pfEmployerPaisa,
        advancePaisa: math.advancePaisa,
        netPaisa: math.netPaisa,
      })
      .where(eq(payrollSlips.id, slip.id));
  }
  await recomputeRunTotals(tx, args.runId);
}

/**
 * "Approve & Post Payroll": DRAFT → POSTED with ONE balanced journal:
 *   Dr 6011 Salaries & Wages Expense        (gross)
 *   Dr 6012 Employer Contribution Expense   (EOBI/PF employer match)
 *   Cr 2120 Salary Withholding Tax Payable
 *   Cr 2121 EOBI Payable                    (employee + employer)
 *   Cr 2122 PF Payable                      (employee + employer)
 *   Cr 1130 Employee Advances               (knocked-off advances)
 *   Cr 2119 Salaries Payable                (net disbursable)
 * Advances are knocked off FIFO and marked CLEARED/PARTIAL.
 */
export async function postPayrollRun(
  tx: DbTx,
  args: { companyId: string; runId: string; createdById: string }
): Promise<{ journalEntryId: string }> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "DRAFT") throw new UserError(`Run is ${run.status} — only drafts can be posted`, 422, "RUN_NOT_DRAFT");

  const slips = await tx
    .select()
    .from(payrollSlips)
    .where(and(eq(payrollSlips.runId, args.runId), eq(payrollSlips.companyId, args.companyId)));
  if (slips.length === 0) throw new UserError("Cannot post a run with no employees", 422, "RUN_EMPTY");

  await assertPeriodOpen(tx, args.companyId, run.runDate);

  const ac = await accountMap(tx, args.companyId);
  const gross = BigInt(run.grossPaisa);
  const erContrib = BigInt(run.eobiEmployerPaisa) + BigInt(run.pfEmployerPaisa);
  const tax = BigInt(run.taxPaisa);
  const eobi = BigInt(run.eobiEmployeePaisa) + BigInt(run.eobiEmployerPaisa);
  const pf = BigInt(run.pfEmployeePaisa) + BigInt(run.pfEmployerPaisa);
  const adv = BigInt(run.advancePaisa);
  const net = BigInt(run.netPaisa);

  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [
    { accountId: ac[SYS.SALARIES_WAGES_EXPENSE], debit: gross, credit: 0n, memo: `Payroll ${run.year}-${String(run.month).padStart(2, "0")} gross` },
  ];
  if (erContrib > 0n)
    lines.push({ accountId: ac[SYS.EMPLOYER_CONTRIB_EXPENSE], debit: erContrib, credit: 0n, memo: "Employer EOBI/PF contribution" });
  if (tax > 0n) lines.push({ accountId: ac[SYS.SALARY_TAX_PAYABLE], debit: 0n, credit: tax });
  if (eobi > 0n) lines.push({ accountId: ac[SYS.EOBI_PAYABLE], debit: 0n, credit: eobi });
  if (pf > 0n) lines.push({ accountId: ac[SYS.PF_PAYABLE], debit: 0n, credit: pf });
  if (adv > 0n) lines.push({ accountId: ac[SYS.EMPLOYEE_ADVANCES], debit: 0n, credit: adv, memo: "Advance knock-off" });
  lines.push({ accountId: ac[SYS.SALARIES_PAYABLE], debit: 0n, credit: net, memo: "Net salaries payable" });

  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date: run.runDate,
    memo: `Payroll ${run.year}-${String(run.month).padStart(2, "0")} — ${slips.length} employee(s)`,
    reference: run.docNo ?? undefined,
    source: "PAYROLL",
    sourceId: args.runId,
    idempotencyKey: `payroll-run:${args.runId}`,
    createdById: args.createdById,
    lines,
  });

  // Knock off advances FIFO per slip.
  for (const slip of slips) {
    let remaining = BigInt(slip.advancePaisa);
    if (remaining <= 0n) continue;
    const open = await openAdvancesFor(tx, args.companyId, slip.employeeId);
    for (const a of open) {
      if (remaining <= 0n) break;
      const take = a.balancePaisa < remaining ? a.balancePaisa : remaining;
      const newBal = a.balancePaisa - take;
      remaining -= take;
      await tx
        .update(employeeAdvances)
        .set({
          balancePaisa: newBal,
          status: newBal === 0n ? "CLEARED" : "PARTIAL",
          clearedRunId: args.runId,
        })
        .where(eq(employeeAdvances.id, a.id));
    }
  }

  await tx
    .update(payrollRuns)
    .set({ status: "POSTED", journalEntryId, postedAt: new Date() })
    .where(eq(payrollRuns.id, args.runId));
  return { journalEntryId };
}

/** Void a POSTED run via a reversing journal; advance balances are restored. */
export async function voidPayrollRun(
  tx: DbTx,
  args: { companyId: string; runId: string; createdById: string }
): Promise<{ reversingJournalEntryId: string }> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "POSTED") throw new UserError(`Only posted runs can be voided (status: ${run.status})`, 422, "RUN_NOT_POSTED");

  const ac = await accountMap(tx, args.companyId);
  const gross = BigInt(run.grossPaisa);
  const erContrib = BigInt(run.eobiEmployerPaisa) + BigInt(run.pfEmployerPaisa);
  const tax = BigInt(run.taxPaisa);
  const eobi = BigInt(run.eobiEmployeePaisa) + BigInt(run.eobiEmployerPaisa);
  const pf = BigInt(run.pfEmployeePaisa) + BigInt(run.pfEmployerPaisa);
  const adv = BigInt(run.advancePaisa);
  const net = BigInt(run.netPaisa);

  // Mirror image of the posting journal.
  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [];
  lines.push({ accountId: ac[SYS.SALARIES_PAYABLE], debit: net, credit: 0n, memo: "Void payroll" });
  if (adv > 0n) lines.push({ accountId: ac[SYS.EMPLOYEE_ADVANCES], debit: adv, credit: 0n, memo: "Restore advances" });
  if (pf > 0n) lines.push({ accountId: ac[SYS.PF_PAYABLE], debit: pf, credit: 0n });
  if (eobi > 0n) lines.push({ accountId: ac[SYS.EOBI_PAYABLE], debit: eobi, credit: 0n });
  if (tax > 0n) lines.push({ accountId: ac[SYS.SALARY_TAX_PAYABLE], debit: tax, credit: 0n });
  if (erContrib > 0n) lines.push({ accountId: ac[SYS.EMPLOYER_CONTRIB_EXPENSE], debit: 0n, credit: erContrib });
  lines.push({ accountId: ac[SYS.SALARIES_WAGES_EXPENSE], debit: 0n, credit: gross });

  const reversingJournalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date: new Date(),
    memo: `Void payroll ${run.year}-${String(run.month).padStart(2, "0")} (${run.docNo})`,
    reference: run.journalEntryId ?? undefined,
    source: "PAYROLL_VOID",
    sourceId: args.runId,
    idempotencyKey: `payroll-void:${args.runId}`,
    createdById: args.createdById,
    lines,
  });

  // Restore knocked-off advance balances.
  const cleared = await tx
    .select()
    .from(employeeAdvances)
    .where(
      and(
        eq(employeeAdvances.companyId, args.companyId),
        eq(employeeAdvances.clearedRunId, args.runId)
      )
    );
  for (const a of cleared) {
    const restored = BigInt(a.amountPaisa);
    await tx
      .update(employeeAdvances)
      .set({
        balancePaisa: restored,
        status: "OPEN",
        clearedRunId: null,
      })
      .where(eq(employeeAdvances.id, a.id));
  }

  await tx
    .update(payrollRuns)
    .set({ status: "VOIDED", voidedAt: new Date() })
    .where(eq(payrollRuns.id, args.runId));
  return { reversingJournalEntryId };
}

/**
 * Bank disbursement batch: Dr 2119 Salaries Payable / Cr bank account,
 * then run → PAID. Bank balance cache updated transactionally.
 */
export async function disbursePayrollRun(
  tx: DbTx,
  args: { companyId: string; runId: string; bankAccountId: string; date?: Date; createdById: string }
): Promise<{ journalEntryId: string }> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "POSTED") throw new UserError(`Only posted runs can be disbursed (status: ${run.status})`, 422, "RUN_NOT_POSTED");
  const net = BigInt(run.netPaisa);
  if (net <= 0n) throw new UserError("Nothing to disburse", 422, "NOTHING_TO_DISBURSE");

  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, args.bankAccountId), eq(bankAccounts.companyId, args.companyId)))
    .limit(1);
  if (!bank) throw new UserError("Bank/cash account not found", 422, "BANK_NOT_FOUND");

  const date = args.date ?? new Date();
  await assertPeriodOpen(tx, args.companyId, date);

  const ac = await accountMap(tx, args.companyId);
  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date,
    memo: `Salary disbursement ${run.year}-${String(run.month).padStart(2, "0")} — ${bank.name}`,
    reference: run.docNo ?? undefined,
    source: "PAYROLL_DISBURSE",
    sourceId: args.runId,
    idempotencyKey: `payroll-disburse:${args.runId}`,
    createdById: args.createdById,
    lines: [
      { accountId: ac[SYS.SALARIES_PAYABLE], debit: net, credit: 0n },
      { accountId: bank.accountId, debit: 0n, credit: net, memo: bank.name },
    ],
  });
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${net}` })
    .where(eq(bankAccounts.id, bank.id));
  await tx
    .update(payrollRuns)
    .set({
      status: "PAID",
      disbursementJournalEntryId: journalEntryId,
      bankAccountId: bank.id,
      paidAt: new Date(),
    })
    .where(eq(payrollRuns.id, args.runId));
  return { journalEntryId };
}

// ─── Employee advances ───────────────────────────────────────────────

/**
 * Issue an advance: Dr 1130 Employee Advances / Cr bank. The advance sits in
 * OPEN status until a payroll run knocks it off FIFO.
 */
export async function issueEmployeeAdvance(
  tx: DbTx,
  args: {
    companyId: string;
    employeeId: string;
    amountPaisa: bigint;
    date: Date;
    bankAccountId: string;
    note?: string;
    createdById: string;
    idempotencyKey?: string;
  }
): Promise<{ id: string; journalEntryId: string }> {
  if (args.amountPaisa <= 0n) throw new UserError("Advance amount must be positive", 422, "INVALID_AMOUNT");
  const [emp] = await tx
    .select()
    .from(employees)
    .where(and(eq(employees.id, args.employeeId), eq(employees.companyId, args.companyId)))
    .limit(1);
  if (!emp) throw new UserError("Employee not found", 422, "EMPLOYEE_NOT_FOUND");
  if (!emp.isActive) throw new UserError("Employee is not active", 422, "EMPLOYEE_INACTIVE");

  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, args.bankAccountId), eq(bankAccounts.companyId, args.companyId)))
    .limit(1);
  if (!bank) throw new UserError("Bank/cash account not found", 422, "BANK_NOT_FOUND");

  await assertPeriodOpen(tx, args.companyId, args.date);

  const ac = await accountMap(tx, args.companyId);
  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date: args.date,
    memo: `Advance to ${emp.fullName} (${emp.code})`,
    reference: await nextDocNo(tx, args.companyId, "EMPLOYEE_ADVANCE"),
    source: "EMPLOYEE_ADVANCE",
    createdById: args.createdById,
    ...(args.idempotencyKey ? { idempotencyKey: args.idempotencyKey } : {}),
    lines: [
      { accountId: ac[SYS.EMPLOYEE_ADVANCES], debit: args.amountPaisa, credit: 0n },
      { accountId: bank.accountId, debit: 0n, credit: args.amountPaisa, memo: bank.name },
    ],
  });
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${args.amountPaisa}` })
    .where(eq(bankAccounts.id, bank.id));

  const id = crypto.randomUUID();
  await tx.insert(employeeAdvances).values({
    id,
    companyId: args.companyId,
    employeeId: emp.id,
    date: args.date,
    amountPaisa: args.amountPaisa,
    balancePaisa: args.amountPaisa,
    status: "OPEN",
    bankAccountId: bank.id,
    journalEntryId,
    note: args.note?.slice(0, 500) ?? null,
    createdById: args.createdById,
  });
  return { id, journalEntryId };
}

// ─── Bank advice CSV ─────────────────────────────────────────────────

export type AdviceRow = {
  code: string;
  name: string;
  bankAccountNo: string;
  netPaisa: bigint;
  month: string;
};

export function bankAdviceCsv(rows: AdviceRow[]): string {
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  const lines = ["Employee Code,Employee Name,Bank Account,Net Payable (Rs),Month"];
  for (const r of rows) {
    const rs = (r.netPaisa / 100n).toString() + "." + (r.netPaisa % 100n).toString().padStart(2, "0");
    lines.push([esc(r.code), esc(r.name), esc(r.bankAccountNo || "-"), rs, r.month].join(","));
  }
  return lines.join("\n");
}
