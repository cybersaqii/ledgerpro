/**
 * Module 16 — Report preset registry.
 *
 * Every core report is a PARAMETER PRESET over the parametric engine
 * (lib/report-engine.ts), not a bespoke SQL report. Each preset declares:
 *   - category, permission, PRO gating
 *   - which param fields its form shows + defaults
 *   - a runner that queries the single journal-lines core (or, for
 *     document/sub-ledger reports, the existing audited lib helpers)
 *     and returns { columns, rows, moneyCols, totals }.
 *
 * Money: paisa bigint in, paisa DECIMAL STRING out (never float).
 * Tenant isolation: company_id on every query.
 */

import { eq, and, asc, sql, inArray } from "drizzle-orm";
import {
  accounts,
  branches,
  journalEntries,
  journalLines,
  parties,
  payrollRuns,
  pdcCheques,
  products,
  projects,
  purchaseDocs,
  salesDocs,
  stockLevels,
  stockMovements,
} from "@/db/schema";
import { SYS } from "./setup";
import { glSums, sumByType, sumByTypeCredit, netOf, netProfit } from "./reports";
import { agingBucket, daysOverdue, AGING_BUCKETS, AGING_LABELS } from "./aging";
import { buildProductSalesReport } from "./product-report";
import { UserError } from "./errors";
import type { Db } from "./db";
import {
  dateRangeMs,
  pivotLines,
  runningBalance,
  variancePct,
  prevPeriod,
  type EngineLine,
  type ReportParams,
} from "./report-engine";

export type ReportCategory =
  | "accounting"
  | "sales"
  | "purchases"
  | "parties"
  | "inventory"
  | "cashbank"
  | "taxpayroll"
  | "projects";

export type ParamField =
  | "from"
  | "to"
  | "bucket"
  | "groupBy"
  | "view"
  | "partyId"
  | "projectId"
  | "branchId"
  | "accountId"
  | "productId";

export interface ColumnDef {
  key: string;
  label: string;
  money?: boolean;
}

export interface PresetResult {
  columns: ColumnDef[];
  rows: (string | number)[][];
  moneyCols?: string[];
  totals?: { label: string; value: string }[];
  meta?: Record<string, string>;
}

export interface PresetCtx {
  db: Db;
  companyId: string;
  params: ReportParams;
  fyStart: string;
}

export interface ReportPreset {
  key: string;
  category: ReportCategory;
  perm: "reports_basic" | "reports_accounting";
  pro: boolean;
  titleKey: string;
  descKey: string;
  fields: ParamField[];
  defaults: Partial<ReportParams>;
  run: (ctx: PresetCtx) => Promise<PresetResult>;
}

export function getPreset(key: string): ReportPreset {
  const p = REPORT_PRESETS[key];
  if (!p) throw new UserError(`Unknown report: ${key}.`, 422, "UNKNOWN_REPORT");
  return p;
}

export function listPresets(): ReportPreset[] {
  return Object.values(REPORT_PRESETS);
}

// ─── The parametric core query ────────────────────────────────────────────
// ONE query shape serves every GL-native report: journal lines joined to
// their entry + account (+ party/project/branch labels), company-isolated,
// date-ranged, entity-filtered. Journal entries carry no status column —
// voids are reversing entries, so every line is effective.

export interface EngineQueryOpts {
  accountTypes?: string[];
  accountCodes?: string[];
  fromMs?: number | null;
  toMs?: number | null; // exclusive
}

function asMs(d: unknown): number {
  if (d instanceof Date) return d.getTime();
  const n = Number(d);
  return isNaN(n) ? 0 : n;
}

export async function fetchEngineLines(ctx: PresetCtx, opts: EngineQueryOpts = {}): Promise<EngineLine[]> {
  const { db, companyId, params } = ctx;
  const [pFrom, pTo] = dateRangeMs(params.from, params.to);
  const fromMs = opts.fromMs !== undefined ? opts.fromMs : pFrom;
  const toMs = opts.toMs !== undefined ? opts.toMs : pTo;

  const conds = [eq(journalEntries.companyId, companyId)];
  if (fromMs != null) conds.push(sql`${journalEntries.date} >= ${fromMs}`);
  if (toMs != null) conds.push(sql`${journalEntries.date} < ${toMs}`);
  if (params.partyId) conds.push(eq(journalLines.partyId, params.partyId));
  if (params.projectId) conds.push(eq(journalLines.projectId, params.projectId));
  if (params.branchId) conds.push(eq(journalEntries.branchId, params.branchId));
  if (params.accountId) conds.push(eq(journalLines.accountId, params.accountId));
  if (opts.accountTypes?.length) conds.push(inArray(accounts.type, opts.accountTypes));
  if (opts.accountCodes?.length) conds.push(inArray(accounts.code, opts.accountCodes));

  const rows = await db
    .select({
      entryId: journalLines.entryId,
      date: journalEntries.date,
      debit: journalLines.debit,
      credit: journalLines.credit,
      accountId: journalLines.accountId,
      accountCode: accounts.code,
      accountName: accounts.name,
      accountType: accounts.type,
      partyId: journalLines.partyId,
      partyName: parties.name,
      projectId: journalLines.projectId,
      projectName: projects.name,
      branchId: journalEntries.branchId,
      branchName: branches.name,
      memo: journalLines.memo,
      reference: journalEntries.reference,
      docNo: journalEntries.docNo,
      source: journalEntries.source,
      sourceId: journalEntries.sourceId,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .leftJoin(parties, eq(journalLines.partyId, parties.id))
    .leftJoin(projects, eq(journalLines.projectId, projects.id))
    .leftJoin(branches, eq(journalEntries.branchId, branches.id))
    .where(and(...conds))
    .orderBy(asc(journalEntries.date));

  return rows.map((r) => ({
    entryId: r.entryId,
    dateMs: asMs(r.date),
    debit: BigInt(r.debit ?? 0),
    credit: BigInt(r.credit ?? 0),
    accountId: r.accountId,
    accountCode: r.accountCode,
    accountName: r.accountName,
    accountType: r.accountType,
    partyId: r.partyId,
    partyName: r.partyName,
    projectId: r.projectId,
    projectName: r.projectName,
    branchId: r.branchId,
    branchName: r.branchName,
    memo: r.memo ?? "",
    reference: r.reference,
    docNo: r.docNo,
    source: r.source,
    sourceId: r.sourceId,
  }));
}

const M = (v: bigint) => v.toString();
const MAX_ROWS = 2000;

function moneyColsOf(cols: ColumnDef[]): string[] {
  return cols.filter((c) => c.money).map((c) => c.key);
}

// ─── GL-native presets ────────────────────────────────────────────────────

const trialBalance: ReportPreset = {
  key: "trial-balance",
  category: "accounting",
  perm: "reports_basic",
  pro: false,
  titleKey: "trialBalance",
  descKey: "trialBalanceText",
  fields: ["from", "to"],
  defaults: { groupBy: "account" },
  // Wraps the audited Module-5 GL helpers (glSums) — same math as the
  // existing trial-balance report, driven by engine params.
  run: async (ctx) => {
    const sums = await glSums(ctx.db, ctx.companyId, ctx.params.from, ctx.params.to);
    const accs = await ctx.db
      .select({ id: accounts.id, code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(eq(accounts.companyId, ctx.companyId));
    const rows: (string | number)[][] = [];
    let td = 0n;
    let tc = 0n;
    for (const a of accs.sort((x, y) => (x.code < y.code ? -1 : 1))) {
      const s = sums.get(a.code);
      const d = s?.debit ?? 0n;
      const c = s?.credit ?? 0n;
      if (d === 0n && c === 0n) continue;
      rows.push([a.code, a.name, a.type, M(d), M(c)]);
      td += d;
      tc += c;
    }
    const columns: ColumnDef[] = [
      { key: "code", label: "Code" },
      { key: "name", label: "Account" },
      { key: "type", label: "Type" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [
        { label: "Total debit", value: M(td) },
        { label: "Total credit", value: M(tc) },
      ],
      meta: { balanced: td === tc ? "true" : "false" },
    };
  },
};

const generalLedger: ReportPreset = {
  key: "general-ledger",
  category: "accounting",
  perm: "reports_basic",
  pro: false,
  titleKey: "generalLedger",
  descKey: "generalLedgerText",
  fields: ["from", "to", "groupBy", "view", "branchId", "projectId"],
  defaults: { groupBy: "account", view: "summary" },
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx);
    if (ctx.params.view === "detail") {
      const rows = lines.slice(0, MAX_ROWS).map((l) => [
        new Date(l.dateMs).toISOString().slice(0, 10),
        l.docNo ?? l.reference ?? "",
        `${l.accountCode} — ${l.accountName}`,
        l.memo,
        M(l.debit),
        M(l.credit),
        l.entryId,
      ]);
      const columns: ColumnDef[] = [
        { key: "date", label: "Date" },
        { key: "doc", label: "Doc" },
        { key: "account", label: "Account" },
        { key: "memo", label: "Memo" },
        { key: "debit", label: "Debit", money: true },
        { key: "credit", label: "Credit", money: true },
        { key: "entryId", label: "Entry" },
      ];
      const meta: Record<string, string> = {};
      if (lines.length > MAX_ROWS) meta.truncated = "true";
      return {
        columns,
        rows,
        moneyCols: moneyColsOf(columns),
        meta,
      };
    }
    const piv = pivotLines(lines, ctx.params.groupBy === "none" ? "account" : ctx.params.groupBy);
    const rows = piv.map((r) => [r.groupLabel, M(r.debit), M(r.credit), M(r.net), r.count]);
    const columns: ColumnDef[] = [
      { key: "group", label: "Group" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
      { key: "net", label: "Net (Dr−Cr)", money: true },
      { key: "lines", label: "Lines" },
    ];
    return { columns, rows, moneyCols: moneyColsOf(columns) };
  },
};

const accountStatement: ReportPreset = {
  key: "account-statement",
  category: "accounting",
  perm: "reports_accounting",
  pro: true,
  titleKey: "accountStatement",
  descKey: "accountStatementText",
  fields: ["from", "to", "accountId"],
  defaults: {},
  run: async (ctx) => {
    if (!ctx.params.accountId) throw new UserError("accountId is required for an account statement.", 422, "ACCOUNT_REQUIRED");
    const [acc] = await ctx.db
      .select({ code: accounts.code, name: accounts.name, type: accounts.type })
      .from(accounts)
      .where(and(eq(accounts.id, ctx.params.accountId), eq(accounts.companyId, ctx.companyId)))
      .limit(1);
    if (!acc) throw new UserError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
    const creditNormal = acc.type === "LIABILITY" || acc.type === "EQUITY" || acc.type === "INCOME";
    const lines = await fetchEngineLines(ctx);
    const seq = runningBalance(lines, creditNormal);
    const rows = seq.slice(0, MAX_ROWS).map(({ line: l, balance }) => [
      new Date(l.dateMs).toISOString().slice(0, 10),
      l.docNo ?? l.reference ?? "",
      l.memo,
      M(l.debit),
      M(l.credit),
      M(balance),
      l.entryId,
    ]);
    const columns: ColumnDef[] = [
      { key: "date", label: "Date" },
      { key: "doc", label: "Doc" },
      { key: "memo", label: "Memo" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
      { key: "balance", label: "Balance", money: true },
      { key: "entryId", label: "Entry" },
    ];
    const last = seq.length ? seq[seq.length - 1].balance : 0n;
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [{ label: `Closing balance — ${acc.code} ${acc.name}`, value: M(last) }],
      meta: (() => { const m: Record<string, string> = { account: `${acc.code} — ${acc.name}` }; if (seq.length > MAX_ROWS) m.truncated = "true"; return m; })(),
    };
  },
};

const dayBook: ReportPreset = {
  key: "day-book",
  category: "accounting",
  perm: "reports_basic",
  pro: false,
  titleKey: "dayBook",
  descKey: "dayBookText",
  fields: ["from", "to", "view"],
  defaults: { view: "detail" },
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx);
    // Entry-level rollup: every voucher of the day(s) in time order.
    const byEntry = new Map<string, { dateMs: number; doc: string; memo: string; d: bigint; c: bigint; source: string }>();
    for (const l of lines) {
      let e = byEntry.get(l.entryId);
      if (!e) {
        e = { dateMs: l.dateMs, doc: l.docNo ?? l.reference ?? "", memo: "", d: 0n, c: 0n, source: l.source };
        byEntry.set(l.entryId, e);
      }
      e.d += l.debit;
      e.c += l.credit;
    }
    const entries = [...byEntry.entries()].sort((a, b) => a[1].dateMs - b[1].dateMs);
    const rows: (string | number)[][] = [];
    for (const [id, e] of entries.slice(0, MAX_ROWS)) {
      rows.push([new Date(e.dateMs).toISOString().slice(0, 10), e.doc, e.source, M(e.d), M(e.c), id]);
      if (ctx.params.view === "detail") {
        for (const l of lines.filter((x) => x.entryId === id)) {
          rows.push(["", "", `↳ ${l.accountCode} — ${l.accountName} · ${l.memo}`, M(l.debit), M(l.credit), ""]);
        }
      }
    }
    const columns: ColumnDef[] = [
      { key: "date", label: "Date" },
      { key: "doc", label: "Doc" },
      { key: "source", label: "Source" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
      { key: "entryId", label: "Entry" },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      meta: (() => { const m: Record<string, string> = { vouchers: String(entries.length) }; if (entries.length > MAX_ROWS) m.truncated = "true"; return m; })(),
    };
  },
};

const journalDetail: ReportPreset = {
  key: "journal-detail",
  category: "accounting",
  perm: "reports_accounting",
  pro: true,
  titleKey: "journal",
  descKey: "journalText",
  fields: ["from", "to", "branchId", "projectId"],
  defaults: {},
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx);
    const rows = lines.slice(0, MAX_ROWS).map((l) => [
      new Date(l.dateMs).toISOString().slice(0, 10),
      l.docNo ?? l.reference ?? "",
      `${l.accountCode} — ${l.accountName}`,
      l.partyName ?? "",
      l.memo,
      M(l.debit),
      M(l.credit),
      l.entryId,
    ]);
    const columns: ColumnDef[] = [
      { key: "date", label: "Date" },
      { key: "doc", label: "Doc" },
      { key: "account", label: "Account" },
      { key: "party", label: "Party" },
      { key: "memo", label: "Memo" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
      { key: "entryId", label: "Entry" },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      meta: (() => { const m: Record<string, string> = { lines: String(lines.length) }; if (lines.length > MAX_ROWS) m.truncated = "true"; return m; })(),
    };
  },
};

const incomeByAccount: ReportPreset = {
  key: "income-by-account",
  category: "sales",
  perm: "reports_accounting",
  pro: true,
  titleKey: "incomeByAccount",
  descKey: "incomeByAccountText",
  fields: ["from", "to", "groupBy", "branchId", "projectId"],
  defaults: { groupBy: "account" },
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountTypes: ["INCOME"] });
    const piv = pivotLines(lines, ctx.params.groupBy === "none" ? "account" : ctx.params.groupBy);
    const rows = piv.map((r) => [r.groupLabel, M(r.credit - r.debit), r.count]);
    const total = piv.reduce((a, r) => a + (r.credit - r.debit), 0n);
    const columns: ColumnDef[] = [
      { key: "group", label: "Group" },
      { key: "income", label: "Income", money: true },
      { key: "lines", label: "Lines" },
    ];
    return { columns, rows, moneyCols: moneyColsOf(columns), totals: [{ label: "Total income", value: M(total) }] };
  },
};

const expenseByCategory: ReportPreset = {
  key: "expense-by-category",
  category: "purchases",
  perm: "reports_accounting",
  pro: true,
  titleKey: "expenseByCategory",
  descKey: "expenseByCategoryText",
  fields: ["from", "to", "groupBy", "branchId", "projectId"],
  defaults: { groupBy: "account" },
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountTypes: ["EXPENSE"] });
    const piv = pivotLines(lines, ctx.params.groupBy === "none" ? "account" : ctx.params.groupBy);
    const rows = piv.map((r) => [r.groupLabel, M(r.debit - r.credit), r.count]);
    const total = piv.reduce((a, r) => a + (r.debit - r.credit), 0n);
    const columns: ColumnDef[] = [
      { key: "group", label: "Group" },
      { key: "expense", label: "Expense", money: true },
      { key: "lines", label: "Lines" },
    ];
    return { columns, rows, moneyCols: moneyColsOf(columns), totals: [{ label: "Total expense", value: M(total) }] };
  },
};

const cashBankSummary: ReportPreset = {
  key: "cash-bank-summary",
  category: "cashbank",
  perm: "reports_basic",
  pro: false,
  titleKey: "cashBankSummary",
  descKey: "cashBankSummaryText",
  fields: ["from", "to", "branchId"],
  defaults: {},
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountCodes: [SYS.CASH, SYS.BANK] });
    const piv = pivotLines(lines, "account");
    const rows = piv.map((r) => [r.groupLabel, M(r.debit), M(r.credit), M(r.debit - r.credit)]);
    const columns: ColumnDef[] = [
      { key: "account", label: "Account" },
      { key: "in", label: "In", money: true },
      { key: "out", label: "Out", money: true },
      { key: "balance", label: "Net", money: true },
    ];
    return { columns, rows, moneyCols: moneyColsOf(columns) };
  },
};

// Module 17 — PDC calendar / aging: every PENDING post-dated cheque bucketed
// by how far past its cheque date it is (due = cheque date). Two rows —
// cheques received from customers, cheques issued to suppliers — so the shop
// sees at a glance what to deposit and what will hit the bank.
const pdcAging: ReportPreset = {
  key: "pdc-aging",
  category: "cashbank",
  perm: "reports_basic",
  pro: false,
  titleKey: "pdcAging",
  descKey: "pdcAgingText",
  fields: ["from", "to", "partyId"],
  defaults: {},
  run: async (ctx) => {
    const now = Date.now();
    const conds = [
      eq(pdcCheques.companyId, ctx.companyId),
      eq(pdcCheques.status, "PENDING"),
    ];
    if (ctx.params.partyId) conds.push(eq(pdcCheques.partyId, ctx.params.partyId));
    if (ctx.params.from) {
      const f = Date.parse(ctx.params.from);
      if (!isNaN(f)) conds.push(sql`${pdcCheques.chequeDate} >= ${f}`);
    }
    if (ctx.params.to) {
      const t = Date.parse(ctx.params.to);
      if (!isNaN(t)) conds.push(sql`${pdcCheques.chequeDate} <= ${t + 86399999}`);
    }
    const rows = await ctx.db
      .select({
        kind: pdcCheques.kind,
        chequeDate: pdcCheques.chequeDate,
        amount: pdcCheques.amount,
      })
      .from(pdcCheques)
      .where(and(...conds));
    const blank = () => ({ notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n, total: 0n, count: 0 });
    const byKind = new Map<string, ReturnType<typeof blank>>();
    for (const r of rows) {
      const amount = BigInt(r.amount ?? 0);
      const bucket = agingBucket(daysOverdue(null, asMs(r.chequeDate), now));
      let g = byKind.get(r.kind);
      if (!g) { g = blank(); byKind.set(r.kind, g); }
      g[bucket] += amount;
      g.total += amount;
      g.count += 1;
    }
    const kindLabel = (k: string) => (k === "RECEIVED" ? "Received" : "Issued");
    const out = [...byKind.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, g]) => [kindLabel(k), `${g.count}`, ...AGING_BUCKETS.map((bk) => M(g[bk])), M(g.total)]);
    const grand = blank();
    for (const [, g] of byKind) {
      grand.count += g.count;
      grand.total += g.total;
      for (const bk of AGING_BUCKETS) grand[bk] += g[bk];
    }
    const columns: ColumnDef[] = [
      { key: "kind", label: "Kind" },
      { key: "count", label: "Cheques" },
      ...AGING_BUCKETS.map((bk) => ({ key: bk, label: AGING_LABELS[bk], money: true })),
      { key: "total", label: "Total", money: true },
    ];
    return {
      columns,
      rows: out,
      moneyCols: moneyColsOf(columns),
      totals: [
        { label: "Pending cheques", value: String(grand.count) },
        { label: "Pending total", value: M(grand.total) },
      ],
    };
  },
};

const partyLedger: ReportPreset = {
  key: "party-ledger",
  category: "parties",
  perm: "reports_basic",
  pro: false,
  titleKey: "partyLedger",
  descKey: "partyLedgerText",
  fields: ["from", "to", "partyId"],
  defaults: {},
  run: async (ctx) => {
    if (!ctx.params.partyId) throw new UserError("partyId is required for a party ledger.", 422, "PARTY_REQUIRED");
    const [p] = await ctx.db
      .select({ name: parties.name, kind: parties.kind })
      .from(parties)
      .where(and(eq(parties.id, ctx.params.partyId), eq(parties.companyId, ctx.companyId)))
      .limit(1);
    if (!p) throw new UserError("Party not found.", 404, "PARTY_NOT_FOUND");
    // Customer balances are debit-normal (AR), supplier balances credit-normal (AP).
    const creditNormal = p.kind === "SUPPLIER";
    const lines = await fetchEngineLines(ctx);
    const seq = runningBalance(lines, creditNormal);
    const rows = seq.slice(0, MAX_ROWS).map(({ line: l, balance }) => [
      new Date(l.dateMs).toISOString().slice(0, 10),
      l.docNo ?? l.reference ?? "",
      `${l.accountCode} — ${l.accountName}`,
      l.memo,
      M(l.debit),
      M(l.credit),
      M(balance),
      l.entryId,
    ]);
    const columns: ColumnDef[] = [
      { key: "date", label: "Date" },
      { key: "doc", label: "Doc" },
      { key: "account", label: "Account" },
      { key: "memo", label: "Memo" },
      { key: "debit", label: "Debit", money: true },
      { key: "credit", label: "Credit", money: true },
      { key: "balance", label: "Balance", money: true },
      { key: "entryId", label: "Entry" },
    ];
    const last = seq.length ? seq[seq.length - 1].balance : 0n;
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [{ label: `Closing balance — ${p.name}`, value: M(last) }],
      meta: (() => { const m: Record<string, string> = { party: p.name }; if (seq.length > MAX_ROWS) m.truncated = "true"; return m; })(),
    };
  },
};

const projectProfitability: ReportPreset = {
  key: "project-profitability",
  category: "projects",
  perm: "reports_accounting",
  pro: true,
  titleKey: "projectProfitability",
  descKey: "projectProfitabilityText",
  fields: ["from", "to", "groupBy", "projectId"],
  defaults: { groupBy: "project" },
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountTypes: ["INCOME", "EXPENSE"] });
    const byProject = new Map<string, { label: string; revenue: bigint; cost: bigint }>();
    for (const l of lines) {
      const key = l.projectId ?? "none";
      let g = byProject.get(key);
      if (!g) {
        g = { label: l.projectName ?? "(no project)", revenue: 0n, cost: 0n };
        byProject.set(key, g);
      }
      if (l.accountType === "INCOME") g.revenue += l.credit - l.debit;
      else g.cost += l.debit - l.credit;
    }
    const rows = [...byProject.values()]
      .map((g) => ({ ...g, profit: g.revenue - g.cost }))
      .sort((a, b) => (a.label < b.label ? -1 : 1))
      .map((g) => [g.label, M(g.revenue), M(g.cost), M(g.profit)]);
    const columns: ColumnDef[] = [
      { key: "project", label: "Project" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "cost", label: "Cost", money: true },
      { key: "profit", label: "Profit", money: true },
    ];
    const tRev = [...byProject.values()].reduce((a, g) => a + g.revenue, 0n);
    const tCost = [...byProject.values()].reduce((a, g) => a + g.cost, 0n);
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [
        { label: "Total revenue", value: M(tRev) },
        { label: "Total cost", value: M(tCost) },
        { label: "Total profit", value: M(tRev - tCost) },
      ],
    };
  },
};

const branchPnl: ReportPreset = {
  key: "branch-pnl",
  category: "projects",
  perm: "reports_accounting",
  pro: true,
  titleKey: "branchPnl",
  descKey: "branchPnlText",
  fields: ["from", "to", "branchId"],
  defaults: {},
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountTypes: ["INCOME", "EXPENSE"] });
    const byBranch = new Map<string, { label: string; revenue: bigint; cost: bigint }>();
    for (const l of lines) {
      const key = l.branchId ?? "none";
      let g = byBranch.get(key);
      if (!g) {
        g = { label: l.branchName ?? "(no branch)", revenue: 0n, cost: 0n };
        byBranch.set(key, g);
      }
      if (l.accountType === "INCOME") g.revenue += l.credit - l.debit;
      else g.cost += l.debit - l.credit;
    }
    const rows = [...byBranch.values()]
      .map((g) => ({ ...g, profit: g.revenue - g.cost }))
      .sort((a, b) => (a.label < b.label ? -1 : 1))
      .map((g) => [g.label, M(g.revenue), M(g.cost), M(g.profit)]);
    const columns: ColumnDef[] = [
      { key: "branch", label: "Branch" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "expense", label: "Expense", money: true },
      { key: "profit", label: "Net profit", money: true },
    ];
    return { columns, rows, moneyCols: moneyColsOf(columns) };
  },
};

const comparativePnl: ReportPreset = {
  key: "comparative-pnl",
  category: "accounting",
  perm: "reports_accounting",
  pro: true,
  titleKey: "comparativePnl",
  descKey: "comparativePnlText",
  fields: ["from", "to", "view"],
  defaults: { view: "comparative" },
  run: async (ctx) => {
    const [fromMs, toMs] = dateRangeMs(ctx.params.from, ctx.params.to);
    if (fromMs == null || toMs == null)
      throw new UserError("Comparative P&L needs a from/to date range.", 422, "RANGE_REQUIRED");
    const [pFrom, pTo] = prevPeriod(fromMs, toMs);
    const cur = await fetchEngineLines(ctx, { accountTypes: ["INCOME", "EXPENSE"], fromMs, toMs });
    const prev = await fetchEngineLines(ctx, { accountTypes: ["INCOME", "EXPENSE"], fromMs: pFrom, toMs: pTo });
    const sum = (ls: EngineLine[], t: string) =>
      ls.filter((l) => l.accountType === t).reduce((a, l) => a + (t === "INCOME" ? l.credit - l.debit : l.debit - l.credit), 0n);
    const cI = sum(cur, "INCOME");
    const cE = sum(cur, "EXPENSE");
    const pI = sum(prev, "INCOME");
    const pE = sum(prev, "EXPENSE");
    const cN = cI - cE;
    const pN = pI - pE;
    const showVariance = ctx.params.view === "variance";
    const rows: (string | number)[][] = [
      ["Income", M(cI), M(pI), ...(showVariance ? [variancePct(cI, pI) ?? "—"] : [])],
      ["Expense", M(cE), M(pE), ...(showVariance ? [variancePct(cE, pE) ?? "—"] : [])],
      ["Net profit", M(cN), M(pN), ...(showVariance ? [variancePct(cN, pN) ?? "—"] : [])],
    ];
    const columns: ColumnDef[] = [
      { key: "line", label: "" },
      { key: "current", label: "Current period", money: true },
      { key: "previous", label: "Previous period", money: true },
      ...(showVariance ? [{ key: "variance", label: "Variance %" }] : []),
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      meta: {
        current: `${ctx.params.from} → ${ctx.params.to}`,
        previous: `${new Date(pFrom).toISOString().slice(0, 10)} → ${new Date(pTo - 1).toISOString().slice(0, 10)}`,
      },
    };
  },
};

const profitLoss: ReportPreset = {
  key: "profit-loss",
  category: "accounting",
  perm: "reports_accounting",
  pro: true,
  titleKey: "profitLoss",
  descKey: "profitLossText",
  fields: ["from", "to", "branchId", "projectId"],
  defaults: {},
  // Wraps Module-5 helpers (netProfit/sumByType over glSums) — same audited
  // math as the P&L page, driven by engine params. Not rebuilt.
  run: async (ctx) => {
    const sums = await glSums(ctx.db, ctx.companyId, ctx.params.from, ctx.params.to);
    const incomeTotal = sumByTypeCredit(sums, "INCOME");
    const expenseTotal = sumByType(sums, "EXPENSE");
    const net = await netProfit(ctx.db, ctx.companyId, ctx.params.from, ctx.params.to);
    const rows: (string | number)[][] = [];
    const codes = [...sums.keys()].sort();
    for (const code of codes) {
      const s = sums.get(code)!;
      if (s.type === "INCOME" && (s.debit !== 0n || s.credit !== 0n))
        rows.push([`${code} — ${s.name}`, "Income", M(s.credit - s.debit)]);
    }
    rows.push(["Total income", "", M(incomeTotal)]);
    for (const code of codes) {
      const s = sums.get(code)!;
      if (s.type === "EXPENSE" && (s.debit !== 0n || s.credit !== 0n))
        rows.push([`${code} — ${s.name}`, "Expense", M(s.debit - s.credit)]);
    }
    rows.push(["Total expense", "", M(expenseTotal)]);
    const columns: ColumnDef[] = [
      { key: "account", label: "Account" },
      { key: "section", label: "Section" },
      { key: "amount", label: "Amount", money: true },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [{ label: "Net profit", value: net }],
    };
  },
};

const balanceSheet: ReportPreset = {
  key: "balance-sheet",
  category: "accounting",
  perm: "reports_accounting",
  pro: true,
  titleKey: "balanceSheet",
  descKey: "balanceSheetText",
  fields: ["to"],
  defaults: {},
  // Point-in-time wrap of the Module-5 type math (same helpers as the BS
  // page): Assets ≡ Liabilities + Equity by construction.
  run: async (ctx) => {
    const sums = await glSums(ctx.db, ctx.companyId, undefined, ctx.params.to);
    const assets = sumByType(sums, "ASSET");
    const liab = sumByTypeCredit(sums, "LIABILITY");
    const equity = sumByTypeCredit(sums, "EQUITY");
    const ar = netOf(sums, SYS.AR);
    const ap = netOf(sums, SYS.AP, true);
    const inv = netOf(sums, SYS.INVENTORY);
    const inTax = netOf(sums, SYS.INPUT_TAX);
    const taxPay = netOf(sums, SYS.TAX_PAYABLE, true);
    const capital = netOf(sums, SYS.CAPITAL, true);
    const rows: (string | number)[][] = [
      ["ASSETS", "", ""],
      ["Trade receivables", "", M(ar)],
      ["Inventory", "", M(inv)],
      ["Input tax", "", M(inTax)],
      ["Other assets", "", M(assets - ar - inv - inTax)],
      ["Total assets", "", M(assets)],
      ["LIABILITIES", "", ""],
      ["Trade payables", "", M(ap)],
      ["Tax payable", "", M(taxPay)],
      ["Other liabilities", "", M(liab - ap - taxPay)],
      ["Total liabilities", "", M(liab)],
      ["EQUITY", "", ""],
      ["Capital", "", M(capital)],
      ["Other equity (incl. retained profit)", "", M(equity - capital)],
      ["Total equity", "", M(equity)],
    ];
    const columns: ColumnDef[] = [
      { key: "line", label: "" },
      { key: "x", label: "" },
      { key: "amount", label: "Amount", money: true },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [
        { label: "Total assets", value: M(assets) },
        { label: "Liabilities + equity", value: M(liab + equity) },
      ],
      meta: { balanced: assets === liab + equity ? "true" : "false" },
    };
  },
};

// ─── Document / sub-ledger presets ────────────────────────────────────────
// These read doc tables and sub-ledgers (not GL lines) but stay parametric:
// same from/to + entity filters, same { columns, rows } envelope, money as
// paisa strings. Aging reuses lib/aging's audited bucket helpers; product
// sales reuses lib/product-report's audited builder.

const salesByCustomer: ReportPreset = {
  key: "sales-by-customer",
  category: "sales",
  perm: "reports_basic",
  pro: false,
  titleKey: "salesByCustomer",
  descKey: "salesByCustomerText",
  fields: ["from", "to", "partyId", "branchId"],
  defaults: {},
  run: async (ctx) => {
    const [fromMs, toMs] = dateRangeMs(ctx.params.from, ctx.params.to);
    const conds = [
      eq(salesDocs.companyId, ctx.companyId),
      eq(salesDocs.docType, "INVOICE"),
      inArray(salesDocs.status, ["POSTED", "PARTIAL"]),
    ];
    if (fromMs != null) conds.push(sql`${salesDocs.date} >= ${fromMs}`);
    if (toMs != null) conds.push(sql`${salesDocs.date} < ${toMs}`);
    if (ctx.params.partyId) conds.push(eq(salesDocs.partyId, ctx.params.partyId));
    if (ctx.params.branchId) conds.push(eq(salesDocs.branchId, ctx.params.branchId));
    const rows = await ctx.db
      .select({
        partyId: salesDocs.partyId,
        partyName: parties.name,
        total: sql<string>`COALESCE(SUM(${salesDocs.grandTotal}),0)`,
        paid: sql<string>`COALESCE(SUM(${salesDocs.amountPaid}),0)`,
        ret: sql<string>`COALESCE(SUM(${salesDocs.returnedTotal}),0)`,
        n: sql<number>`COUNT(*)`,
      })
      .from(salesDocs)
      .innerJoin(parties, eq(salesDocs.partyId, parties.id))
      .where(and(...conds))
      .groupBy(salesDocs.partyId, parties.name)
      .orderBy(sql`SUM(${salesDocs.grandTotal}) DESC`);
    const out = rows.map((r) => {
      const total = BigInt(r.total);
      const paid = BigInt(r.paid);
      const out_ = total - paid - BigInt(r.ret);
      return [r.partyName, M(total), M(paid), M(out_), r.n];
    });
    const columns: ColumnDef[] = [
      { key: "party", label: "Customer" },
      { key: "total", label: "Billed", money: true },
      { key: "paid", label: "Received", money: true },
      { key: "outstanding", label: "Outstanding", money: true },
      { key: "invoices", label: "Invoices" },
    ];
    return { columns, rows: out, moneyCols: moneyColsOf(columns) };
  },
};

const salesByProduct: ReportPreset = {
  key: "sales-by-product",
  category: "sales",
  perm: "reports_basic",
  pro: false,
  titleKey: "salesByProduct",
  descKey: "salesByProductText",
  fields: ["from", "to", "partyId", "productId"],
  defaults: {},
  run: async (ctx) => {
    const [fromMs, toMs] = dateRangeMs(ctx.params.from, ctx.params.to);
    const rep = await buildProductSalesReport(ctx.db, ctx.companyId, {
      fromMs: fromMs ?? undefined,
      toMs: toMs ?? undefined,
      partyId: ctx.params.partyId,
    });
    const rows = rep.rows
      .filter((r) => !ctx.params.productId || r.productId === ctx.params.productId)
      .map((r) => [r.name, r.sku ?? "", (Number(r.qtySold) / 1000).toString(), r.saleValue, r.cogs, r.grossProfit]);
    const columns: ColumnDef[] = [
      { key: "product", label: "Product" },
      { key: "sku", label: "SKU" },
      { key: "qty", label: "Qty sold" },
      { key: "revenue", label: "Revenue", money: true },
      { key: "cogs", label: "COGS", money: true },
      { key: "gross", label: "Gross profit", money: true },
    ];
    return {
      columns,
      rows,
      moneyCols: moneyColsOf(columns),
      totals: [
        { label: "Revenue", value: rep.totals.saleValue },
        { label: "Gross profit", value: rep.totals.grossProfit },
      ],
    };
  },
};

const purchasesBySupplier: ReportPreset = {
  key: "purchases-by-supplier",
  category: "purchases",
  perm: "reports_basic",
  pro: false,
  titleKey: "purchasesBySupplier",
  descKey: "purchasesBySupplierText",
  fields: ["from", "to", "partyId", "branchId"],
  defaults: {},
  run: async (ctx) => {
    const [fromMs, toMs] = dateRangeMs(ctx.params.from, ctx.params.to);
    const conds = [
      eq(purchaseDocs.companyId, ctx.companyId),
      eq(purchaseDocs.docType, "BILL"),
      inArray(purchaseDocs.status, ["POSTED", "PARTIAL"]),
    ];
    if (fromMs != null) conds.push(sql`${purchaseDocs.date} >= ${fromMs}`);
    if (toMs != null) conds.push(sql`${purchaseDocs.date} < ${toMs}`);
    if (ctx.params.partyId) conds.push(eq(purchaseDocs.partyId, ctx.params.partyId));
    if (ctx.params.branchId) conds.push(eq(purchaseDocs.branchId, ctx.params.branchId));
    const rows = await ctx.db
      .select({
        partyName: parties.name,
        total: sql<string>`COALESCE(SUM(${purchaseDocs.grandTotal}),0)`,
        paid: sql<string>`COALESCE(SUM(${purchaseDocs.amountPaid}),0)`,
        ret: sql<string>`COALESCE(SUM(${purchaseDocs.returnedTotal}),0)`,
        n: sql<number>`COUNT(*)`,
      })
      .from(purchaseDocs)
      .innerJoin(parties, eq(purchaseDocs.partyId, parties.id))
      .where(and(...conds))
      .groupBy(purchaseDocs.partyId, parties.name)
      .orderBy(sql`SUM(${purchaseDocs.grandTotal}) DESC`);
    const out = rows.map((r) => {
      const total = BigInt(r.total);
      const paid = BigInt(r.paid);
      return [r.partyName, M(total), M(paid), M(total - paid - BigInt(r.ret)), r.n];
    });
    const columns: ColumnDef[] = [
      { key: "party", label: "Supplier" },
      { key: "total", label: "Billed", money: true },
      { key: "paid", label: "Paid", money: true },
      { key: "outstanding", label: "Outstanding", money: true },
      { key: "bills", label: "Bills" },
    ];
    return { columns, rows: out, moneyCols: moneyColsOf(columns) };
  },
};

function agingPreset(kind: "CUSTOMER" | "SUPPLIER", key: string, titleKey: string): ReportPreset {
  return {
    key,
    category: "parties",
    perm: "reports_basic",
    pro: false,
    titleKey,
    descKey: "agingText",
    fields: ["partyId"],
    defaults: {},
    // Same doc math as /api/reports/aging (outstanding nets returns +
    // write-offs; PARTIAL + POSTED only), bucketed by lib/aging.
    run: async (ctx) => {
      const isSupplier = kind === "SUPPLIER";
      const docs = isSupplier ? purchaseDocs : salesDocs;
      const now = Date.now();
      const conds = [
        eq(docs.companyId, ctx.companyId),
        eq(docs.docType, isSupplier ? "BILL" : "INVOICE"),
        inArray(docs.status, ["POSTED", "PARTIAL"]),
        sql`${docs.grandTotal} > ${docs.amountPaid} + ${docs.returnedTotal} + COALESCE(written_off_amount, 0)`,
      ];
      if (ctx.params.partyId) conds.push(eq(docs.partyId, ctx.params.partyId));
      const rows = await ctx.db
        .select({
          partyId: docs.partyId,
          partyName: parties.name,
          date: docs.date,
          dueDate: docs.dueDate,
          grandTotal: docs.grandTotal,
          amountPaid: docs.amountPaid,
          returnedTotal: docs.returnedTotal,
          writtenOff: sql<string>`COALESCE(written_off_amount, 0)`,
        })
        .from(docs)
        .innerJoin(parties, eq(docs.partyId, parties.id))
        .where(and(...conds))
        .orderBy(docs.date);
      const map = new Map<string, { name: string; buckets: Record<string, bigint>; total: bigint }>();
      for (const r of rows) {
        const outstanding = BigInt(r.grandTotal ?? 0) - BigInt(r.amountPaid ?? 0) - BigInt(r.returnedTotal ?? 0) - BigInt(r.writtenOff ?? "0");
        if (outstanding <= 0n) continue;
        const b = agingBucket(daysOverdue(r.dueDate ? asMs(r.dueDate) : null, asMs(r.date), now));
        let g = map.get(r.partyId);
        if (!g) {
          g = { name: r.partyName, buckets: { notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n }, total: 0n };
          map.set(r.partyId, g);
        }
        g.buckets[b] += outstanding;
        g.total += outstanding;
      }
      const out = [...map.values()]
        .sort((a, b) => (a.total > b.total ? -1 : 1))
        .map((g) => [g.name, ...AGING_BUCKETS.map((bk) => M(g.buckets[bk])), M(g.total)]);
      const columns: ColumnDef[] = [
        { key: "party", label: "Party" },
        ...AGING_BUCKETS.map((bk) => ({ key: bk, label: AGING_LABELS[bk], money: true })),
        { key: "total", label: "Total", money: true },
      ];
      return { columns, rows: out, moneyCols: moneyColsOf(columns) };
    },
  };
}

const stockValuation: ReportPreset = {
  key: "stock-valuation",
  category: "inventory",
  perm: "reports_basic",
  pro: false,
  titleKey: "stockValuation",
  descKey: "stockValuationText",
  fields: ["branchId", "productId"],
  defaults: {},
  run: async (ctx) => {
    const conds = [eq(products.companyId, ctx.companyId)];
    if (ctx.params.productId) conds.push(eq(products.id, ctx.params.productId));
    if (ctx.params.branchId) conds.push(eq(stockLevels.branchId, ctx.params.branchId));
    const rows = await ctx.db
      .select({
        productName: products.name,
        sku: products.sku,
        branchName: branches.name,
        qty: stockLevels.qty,
        avgCost: stockLevels.avgCost,
      })
      .from(stockLevels)
      .innerJoin(products, eq(stockLevels.productId, products.id))
      .innerJoin(branches, eq(stockLevels.branchId, branches.id))
      .where(and(...conds))
      .orderBy(products.name);
    const out: (string | number)[][] = [];
    let totalVal = 0n;
    for (const r of rows) {
      const qty = BigInt(r.qty ?? 0); // milli-units
      const avg = BigInt(r.avgCost ?? 0); // paisa / unit
      const val = (qty * avg) / 1000n;
      if (qty === 0n) continue;
      totalVal += val;
      out.push([r.productName, r.sku ?? "", r.branchName, (Number(qty) / 1000).toString(), M(val)]);
    }
    const columns: ColumnDef[] = [
      { key: "product", label: "Product" },
      { key: "sku", label: "SKU" },
      { key: "branch", label: "Branch" },
      { key: "qty", label: "Qty" },
      { key: "value", label: "Value", money: true },
    ];
    return {
      columns,
      rows: out,
      moneyCols: moneyColsOf(columns),
      totals: [{ label: "Total stock value", value: M(totalVal) }],
    };
  },
};

const stockMovement: ReportPreset = {
  key: "stock-movement",
  category: "inventory",
  perm: "reports_basic",
  pro: false,
  titleKey: "stockMovement",
  descKey: "stockMovementText",
  fields: ["from", "to", "branchId", "productId"],
  defaults: {},
  run: async (ctx) => {
    const [fromMs, toMs] = dateRangeMs(ctx.params.from, ctx.params.to);
    const conds = [eq(stockMovements.companyId, ctx.companyId)];
    if (fromMs != null) conds.push(sql`${stockMovements.date} >= ${fromMs}`);
    if (toMs != null) conds.push(sql`${stockMovements.date} < ${toMs}`);
    if (ctx.params.productId) conds.push(eq(stockMovements.productId, ctx.params.productId));
    if (ctx.params.branchId) conds.push(eq(stockMovements.branchId, ctx.params.branchId));
    const rows = await ctx.db
      .select({
        productName: products.name,
        txnType: stockMovements.txnType,
        inQty: sql<string>`COALESCE(SUM(${stockMovements.inQty}),0)`,
        outQty: sql<string>`COALESCE(SUM(${stockMovements.outQty}),0)`,
        n: sql<number>`COUNT(*)`,
      })
      .from(stockMovements)
      .innerJoin(products, eq(stockMovements.productId, products.id))
      .where(and(...conds))
      .groupBy(stockMovements.productId, products.name, stockMovements.txnType)
      .orderBy(products.name);
    const out = rows.map((r) => {
      const iq = BigInt(r.inQty);
      const oq = BigInt(r.outQty);
      return [r.productName, r.txnType, (Number(iq) / 1000).toString(), (Number(oq) / 1000).toString(), (Number(iq - oq) / 1000).toString(), r.n];
    });
    const columns: ColumnDef[] = [
      { key: "product", label: "Product" },
      { key: "type", label: "Movement" },
      { key: "in", label: "In qty" },
      { key: "out", label: "Out qty" },
      { key: "net", label: "Net qty" },
      { key: "count", label: "Txns" },
    ];
    return { columns, rows: out };
  },
};

const taxSummary: ReportPreset = {
  key: "tax-summary",
  category: "taxpayroll",
  perm: "reports_accounting",
  pro: true,
  titleKey: "taxSummary",
  descKey: "taxSummaryText",
  fields: ["from", "to", "branchId"],
  defaults: {},
  // Engine-native: input tax (debit on 1300) vs output tax (credit on 2100).
  run: async (ctx) => {
    const lines = await fetchEngineLines(ctx, { accountCodes: [SYS.INPUT_TAX, SYS.TAX_PAYABLE] });
    let input = 0n;
    let output = 0n;
    for (const l of lines) {
      if (l.accountCode === SYS.INPUT_TAX) input += l.debit - l.credit;
      else output += l.credit - l.debit;
    }
    const columns: ColumnDef[] = [
      { key: "line", label: "" },
      { key: "amount", label: "Amount", money: true },
    ];
    return {
      columns,
      rows: [
        ["Input tax (paid on purchases)", M(input)],
        ["Output tax (collected on sales)", M(output)],
      ],
      moneyCols: moneyColsOf(columns),
      totals: [{ label: "Net tax payable", value: M(output - input) }],
    };
  },
};

const payrollSummary: ReportPreset = {
  key: "payroll-summary",
  category: "taxpayroll",
  perm: "reports_accounting",
  pro: true,
  titleKey: "payrollSummary",
  descKey: "payrollSummaryText",
  fields: [],
  defaults: {},
  run: async (ctx) => {
    const rows = await ctx.db
      .select({
        year: payrollRuns.year,
        month: payrollRuns.month,
        docNo: payrollRuns.docNo,
        status: payrollRuns.status,
        gross: payrollRuns.grossPaisa,
        tax: payrollRuns.taxPaisa,
        eobi: payrollRuns.eobiEmployeePaisa,
        pf: payrollRuns.pfEmployeePaisa,
        adv: payrollRuns.advancePaisa,
        net: payrollRuns.netPaisa,
      })
      .from(payrollRuns)
      .where(and(eq(payrollRuns.companyId, ctx.companyId), sql`${payrollRuns.status} != 'VOIDED'`))
      .orderBy(sql`${payrollRuns.year} DESC`, sql`${payrollRuns.month} DESC`);
    const out = rows.map((r) => {
      const gross = BigInt(r.gross ?? 0);
      const ded = BigInt(r.tax ?? 0) + BigInt(r.eobi ?? 0) + BigInt(r.pf ?? 0) + BigInt(r.adv ?? 0);
      return [`${r.year}-${String(r.month).padStart(2, "0")}`, r.docNo ?? "", r.status, M(gross), M(ded), M(BigInt(r.net ?? 0))];
    });
    const columns: ColumnDef[] = [
      { key: "month", label: "Month" },
      { key: "doc", label: "Doc" },
      { key: "status", label: "Status" },
      { key: "gross", label: "Gross", money: true },
      { key: "deductions", label: "Deductions", money: true },
      { key: "net", label: "Net payable", money: true },
    ];
    return { columns, rows: out, moneyCols: moneyColsOf(columns) };
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────

export const REPORT_PRESETS: Record<string, ReportPreset> = {
  "trial-balance": trialBalance,
  "general-ledger": generalLedger,
  "account-statement": accountStatement,
  "day-book": dayBook,
  "journal-detail": journalDetail,
  "profit-loss": profitLoss,
  "balance-sheet": balanceSheet,
  "comparative-pnl": comparativePnl,
  "sales-by-customer": salesByCustomer,
  "sales-by-product": salesByProduct,
  "income-by-account": incomeByAccount,
  "purchases-by-supplier": purchasesBySupplier,
  "expense-by-category": expenseByCategory,
  "party-ledger": partyLedger,
  "ar-aging": agingPreset("CUSTOMER", "ar-aging", "arAging"),
  "ap-aging": agingPreset("SUPPLIER", "ap-aging", "apAging"),
  "stock-valuation": stockValuation,
  "stock-movement": stockMovement,
  "cash-bank-summary": cashBankSummary,
  "pdc-aging": pdcAging,
  "tax-summary": taxSummary,
  "payroll-summary": payrollSummary,
  "project-profitability": projectProfitability,
  "branch-pnl": branchPnl,
};

export const REPORT_CATEGORIES: { key: ReportCategory; titleKey: string }[] = [
  { key: "accounting", titleKey: "catAccounting" },
  { key: "sales", titleKey: "catSales" },
  { key: "purchases", titleKey: "catPurchases" },
  { key: "parties", titleKey: "catParties" },
  { key: "inventory", titleKey: "catInventory" },
  { key: "cashbank", titleKey: "catCashBank" },
  { key: "taxpayroll", titleKey: "catTaxPayroll" },
  { key: "projects", titleKey: "catProjects" },
];
