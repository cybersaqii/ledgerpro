/**
 * Module 16 — Parametric Reports Engine (PURE; no DB, no Next.js).
 *
 * Every report in LedgerPro queries ONE parametric core: journal lines
 * (journal_lines JOIN journal_entries JOIN accounts), always scoped to a
 * company. This file is the unit-testable heart:
 *
 *   D1 Time bucket   day | week | month | quarter | fiscalYear | none
 *   D2 Entity filter party | employee | project | branch        (validated ids)
 *   D3 Item/location product | category | branch/warehouse      (validated ids)
 *   D4 View format   summary | detail | comparative | variance
 *   D5 Status        posted (default) | all
 *
 * Grouping / pivot: month | account | accountType | party | project |
 * branch | none, with Dr / Cr / net aggregation. Money is ALWAYS bigint
 * paisa in here — never float.
 *
 * Data-model note (audited 2026-10-01): journal_entries has NO status
 * column — voids are recorded as reversing journal entries, so every
 * journal line is effective. The `status` dimension is accepted for API
 * stability; "posted" and "all" currently select the same rows.
 */

import { UserError } from "./errors";

export type TimeBucket = "day" | "week" | "month" | "quarter" | "fiscalYear" | "none";
export type GroupBy = "month" | "account" | "accountType" | "party" | "project" | "branch" | "none";
export type ViewFormat = "summary" | "detail" | "comparative" | "variance";
export type StatusFilter = "posted" | "all";

export const TIME_BUCKETS: TimeBucket[] = ["day", "week", "month", "quarter", "fiscalYear", "none"];
export const GROUP_BYS: GroupBy[] = ["month", "account", "accountType", "party", "project", "branch", "none"];
export const VIEW_FORMATS: ViewFormat[] = ["summary", "detail", "comparative", "variance"];
export const STATUS_FILTERS: StatusFilter[] = ["posted", "all"];

export interface ReportParams {
  from?: string; // YYYY-MM-DD inclusive
  to?: string; // YYYY-MM-DD inclusive
  bucket: TimeBucket;
  groupBy: GroupBy;
  view: ViewFormat;
  status: StatusFilter;
  partyId?: string;
  employeeId?: string;
  projectId?: string;
  branchId?: string;
  productId?: string;
  categoryId?: string;
  accountId?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

function badParam(msg: string): UserError {
  return new UserError(msg, 422, "BAD_REPORT_PARAM");
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], name: string, def: T): T {
  if (v === undefined || v === null || v === "") return def;
  if (typeof v === "string" && (allowed as readonly string[]).includes(v)) return v as T;
  throw badParam(`Invalid ${name}: expected one of ${allowed.join(", ")}.`);
}

function optId(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string" && ID_RE.test(v)) return v;
  throw badParam(`Invalid ${name}: expected an id.`);
}

function optDate(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string" && DATE_RE.test(v)) {
    const ms = Date.parse(`${v}T00:00:00Z`);
    if (!isNaN(ms)) return v;
  }
  throw badParam(`Invalid ${name}: expected YYYY-MM-DD.`);
}

/** Strictly validate raw (query-string / JSON) input into canonical ReportParams. */
export function validateReportParams(raw: unknown): ReportParams {
  if (typeof raw !== "object" || raw === null) throw badParam("Params must be an object.");
  const r = raw as Record<string, unknown>;
  const from = optDate(r.from, "from");
  const to = optDate(r.to, "to");
  if (from && to && from > to) throw badParam("from must not be after to.");
  return {
    from,
    to,
    bucket: oneOf(r.bucket, TIME_BUCKETS, "bucket", "none"),
    groupBy: oneOf(r.groupBy, GROUP_BYS, "groupBy", "none"),
    view: oneOf(r.view, VIEW_FORMATS, "view", "summary"),
    status: oneOf(r.status, STATUS_FILTERS, "status", "posted"),
    partyId: optId(r.partyId, "partyId"),
    employeeId: optId(r.employeeId, "employeeId"),
    projectId: optId(r.projectId, "projectId"),
    branchId: optId(r.branchId, "branchId"),
    productId: optId(r.productId, "productId"),
    categoryId: optId(r.categoryId, "categoryId"),
    accountId: optId(r.accountId, "accountId"),
  };
}

/** YYYY-MM-DD (inclusive) → [fromMs, toExclusiveMs) in UTC. */
export function dateRangeMs(from?: string, to?: string): [number | null, number | null] {
  const f = from ? Date.parse(`${from}T00:00:00Z`) : NaN;
  const t = to ? Date.parse(`${to}T00:00:00Z`) + 86400000 : NaN;
  return [isNaN(f) ? null : f, isNaN(t) ? null : t];
}

// ─── Time bucketing (all UTC) ─────────────────────────────────────────────

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/** "MM-DD" fiscal-year start (e.g. "07-01") → fiscal year label "2026-27" for ms. */
export function fiscalYearLabelFor(ms: number, fyStart = "07-01"): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const sm = /^\d{2}-\d{2}$/.test(fyStart) ? fyStart : "07-01";
  const startMonth = parseInt(sm.slice(0, 2), 10);
  const startDay = parseInt(sm.slice(3, 5), 10);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  const fy = m > startMonth || (m === startMonth && day >= startDay) ? y : y - 1;
  return `${fy}-${String((fy + 1) % 100).padStart(2, "0")}`;
}

/** Monday (UTC) starting the week that contains ms. */
export function weekStartMs(ms: number): number {
  const d = new Date(ms);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow);
}

/** Bucket key for a timestamp, e.g. "2026-10-01", "2026-W40", "2026-10", "2026-Q4", "2026-27". */
export function bucketKey(ms: number, bucket: TimeBucket, fyStart = "07-01"): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  switch (bucket) {
    case "day":
      return `${y}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
    case "week": {
      const w = new Date(weekStartMs(ms));
      // ISO week number from the Monday
      const thu = new Date(w.getTime() + 3 * 86400000);
      const isoY = thu.getUTCFullYear();
      const jan4 = Date.UTC(isoY, 0, 4);
      const week = Math.floor((weekStartMs(thu.getTime()) - weekStartMs(jan4)) / (7 * 86400000)) + 1;
      return `${isoY}-W${pad2(week)}`;
    }
    case "month":
      return `${y}-${pad2(d.getUTCMonth() + 1)}`;
    case "quarter":
      return `${y}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
    case "fiscalYear":
      return fiscalYearLabelFor(ms, fyStart);
    case "none":
      return "all";
  }
}

/** Sortable start-of-bucket instant for a bucket key. */
export function bucketStartMs(key: string, bucket: TimeBucket, fyStart = "07-01"): number {
  if (bucket === "none") return 0;
  if (bucket === "day") return Date.parse(`${key}T00:00:00Z`);
  if (bucket === "month") return Date.parse(`${key}-01T00:00:00Z`);
  if (bucket === "week") {
    // key "YYYY-Www": Monday of that ISO week
    const m = /^(\d{4})-W(\d{2})$/.exec(key);
    if (!m) return 0;
    const jan4 = Date.UTC(parseInt(m[1], 10), 0, 4);
    return weekStartMs(jan4) + (parseInt(m[2], 10) - 1) * 7 * 86400000;
  }
  if (bucket === "quarter") {
    const m = /^(\d{4})-Q([1-4])$/.exec(key);
    if (!m) return 0;
    return Date.UTC(parseInt(m[1], 10), (parseInt(m[2], 10) - 1) * 3, 1);
  }
  // fiscalYear "YYYY-YY"
  const m = /^(\d{4})-\d{2}$/.exec(key);
  if (!m) return 0;
  const sm = /^\d{2}-\d{2}$/.test(fyStart) ? fyStart : "07-01";
  return Date.UTC(parseInt(m[1], 10), parseInt(sm.slice(0, 2), 10) - 1, parseInt(sm.slice(3, 5), 10));
}

/**
 * Previous period of identical length immediately before [fromMs, toExclMs).
 * Used by comparative / variance views. Both bounds required.
 */
export function prevPeriod(fromMs: number, toExclMs: number): [number, number] {
  const len = toExclMs - fromMs;
  if (!(len > 0)) throw badParam("Comparative view needs a from/to date range.");
  return [fromMs - len, fromMs];
}

// ─── Pivot engine ─────────────────────────────────────────────────────────

export interface EngineLine {
  entryId: string;
  dateMs: number;
  debit: bigint;
  credit: bigint;
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: string;
  partyId: string | null;
  partyName: string | null;
  projectId: string | null;
  projectName: string | null;
  branchId: string | null;
  branchName: string | null;
  memo: string;
  reference: string | null;
  docNo: string | null;
  source: string;
  sourceId: string | null;
}

export interface PivotRow {
  groupKey: string;
  groupLabel: string;
  debit: bigint;
  credit: bigint;
  net: bigint; // debit - credit (debit-normal); callers flip for credit-normal views
  count: number;
}

function groupKeyOf(line: EngineLine, groupBy: GroupBy): { key: string; label: string } {
  switch (groupBy) {
    case "month":
      return { key: bucketKey(line.dateMs, "month"), label: bucketKey(line.dateMs, "month") };
    case "account":
      return { key: line.accountCode, label: `${line.accountCode} — ${line.accountName}` };
    case "accountType":
      return { key: line.accountType, label: line.accountType };
    case "party":
      return { key: line.partyId ?? "none", label: line.partyName ?? "(no party)" };
    case "project":
      return { key: line.projectId ?? "none", label: line.projectName ?? "(no project)" };
    case "branch":
      return { key: line.branchId ?? "none", label: line.branchName ?? "(no branch)" };
    case "none":
      return { key: "all", label: "Total" };
  }
}

/** Group engine lines, summing Dr/Cr as bigint. Rows sorted by group key. */
export function pivotLines(lines: EngineLine[], groupBy: GroupBy): PivotRow[] {
  const map = new Map<string, PivotRow>();
  for (const l of lines) {
    const { key, label } = groupKeyOf(l, groupBy);
    let row = map.get(key);
    if (!row) {
      row = { groupKey: key, groupLabel: label, debit: 0n, credit: 0n, net: 0n, count: 0 };
      map.set(key, row);
    }
    row.debit += l.debit;
    row.credit += l.credit;
    row.count += 1;
  }
  const rows = [...map.values()];
  for (const r of rows) r.net = r.debit - r.credit;
  rows.sort((a, b) => (a.groupKey < b.groupKey ? -1 : a.groupKey > b.groupKey ? 1 : 0));
  return rows;
}

/** Running balance over date-ordered lines. creditNormal flips the sign convention. */
export function runningBalance(
  lines: EngineLine[],
  creditNormal = false
): { line: EngineLine; balance: bigint }[] {
  const ordered = [...lines].sort((a, b) => a.dateMs - b.dateMs);
  let bal = 0n;
  return ordered.map((line) => {
    bal += creditNormal ? line.credit - line.debit : line.debit - line.credit;
    return { line, balance: bal };
  });
}

/**
 * Variance % of cur vs prev as a display string with 2 decimals ("12.50"),
 * negative when down, null when prev is 0 (undefined variance).
 * Pure bigint math — no float.
 */
export function variancePct(cur: bigint, prev: bigint): string | null {
  if (prev === 0n) return null;
  const diff = cur - prev;
  const absDiff = diff < 0n ? -diff : diff;
  const absPrev = prev < 0n ? -prev : prev;
  // basis points = |diff| * 10000 / |prev|  → 2-decimal percent
  const bps = (absDiff * 10000n) / absPrev;
  const rem = (absDiff * 10000n) % absPrev;
  const rounded = rem * 2n >= absPrev ? bps + 1n : bps;
  const sign = diff < 0n ? "-" : "";
  const whole = rounded / 100n;
  const frac = (rounded % 100n).toString().padStart(2, "0");
  return `${sign}${whole.toString()}.${frac}`;
}
