/**
 * Module 23 — Credit control & hard-stop enforcement.
 *
 * Builds on the per-party credit limits in lib/credit-limit.ts (409 on
 * over-limit) with three more layers:
 *
 *  1. Aging-based credit rules per company — block new credit sales when a
 *     customer has any invoice more than N days overdue
 *     (block_if_overdue_days), or when their udhaar utilization passes N%
 *     (block_if_utilization_pct). NULL = that rule disabled.
 *  2. Automatic HOLD status on parties breaching the rules, evaluated on
 *     every sales create and by the nightly /api/cron/credit-control sweep
 *     (or on demand). Holds are released manually with a reason; every
 *     transition is written to credit_hold_events (the audit trail).
 *  3. Risk categories (LOW / MEDIUM / HIGH) auto-computed from the worst
 *     overdue aging bucket, plus a collection-priority ranking for the
 *     receivables page.
 *
 * Money is integer paisa (bigint) throughout. All queries are scoped by
 * companyId. Outstanding per invoice = grandTotal − amountPaid −
 * returnedTotal − writtenOffAmount (same definition as the aging report).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  creditHoldEvents,
  creditRules,
  parties,
  salesDocs,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { agingBucket, daysOverdue, type AgingBucket } from "./aging";
import { creditUtilization } from "./credit-limit";

export type RiskCategory = "LOW" | "MEDIUM" | "HIGH";
export type CreditStatus = "OK" | "HOLD";

export interface CreditRuleSet {
  blockIfOverdueDays: number | null;
  blockIfUtilizationPct: number | null;
}

const DEFAULT_RULES: CreditRuleSet = { blockIfOverdueDays: null, blockIfUtilizationPct: null };

/**
 * Thrown (answered as 409 + code CREDIT_ON_HOLD) when a credit sale is
 * attempted for a party currently on credit hold. Standalone Error subclass
 * (not UserError) — mirrors lib/credit-limit.ts's CreditLimitError so the
 * pattern stays identical at the call sites.
 */
export class CreditHoldError extends Error {
  status = 409;
  code = "CREDIT_ON_HOLD";
  details: { partyName: string; reason: string | null; since: string | null };
  constructor(details: CreditHoldError["details"]) {
    super("This customer is on credit hold.");
    this.name = "CreditHoldError";
    this.details = details;
  }
}

/** Per-company credit rules (defaults = both rules disabled). */
export async function getCreditRules(
  tx: Db | DbTx,
  companyId: string
): Promise<CreditRuleSet> {
  const rows = await tx
    .select({
      blockIfOverdueDays: creditRules.blockIfOverdueDays,
      blockIfUtilizationPct: creditRules.blockIfUtilizationPct,
    })
    .from(creditRules)
    .where(eq(creditRules.companyId, companyId))
    .limit(1);
  const r = rows[0];
  return r
    ? { blockIfOverdueDays: r.blockIfOverdueDays, blockIfUtilizationPct: r.blockIfUtilizationPct }
    : DEFAULT_RULES;
}

/** Create or replace the company's credit rules. Values are validated by the caller. */
export async function upsertCreditRules(
  tx: Db | DbTx,
  companyId: string,
  rules: CreditRuleSet,
  updatedById: string
): Promise<void> {
  await tx
    .insert(creditRules)
    .values({
      companyId,
      blockIfOverdueDays: rules.blockIfOverdueDays,
      blockIfUtilizationPct: rules.blockIfUtilizationPct,
      updatedById,
    })
    .onConflictDoUpdate({
      target: [creditRules.companyId],
      set: {
        blockIfOverdueDays: rules.blockIfOverdueDays,
        blockIfUtilizationPct: rules.blockIfUtilizationPct,
        updatedById,
        updatedAt: new Date(),
      },
    });
}

export interface PartyAging {
  buckets: Record<AgingBucket, bigint>;
  totalOutstanding: bigint;
  /** Oldest days-overdue across open invoices (0 when nothing is overdue). */
  maxDaysOverdue: number;
}

/** Outstanding per aging bucket for one customer's open invoices. */
export async function partyAging(
  tx: Db | DbTx,
  companyId: string,
  partyId: string,
  nowMs = Date.now()
): Promise<PartyAging> {
  const rows = await tx
    .select({
      date: salesDocs.date,
      dueDate: salesDocs.dueDate,
      grandTotal: salesDocs.grandTotal,
      amountPaid: salesDocs.amountPaid,
      returnedTotal: salesDocs.returnedTotal,
      writtenOffAmount: salesDocs.writtenOffAmount,
    })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.partyId, partyId),
        eq(salesDocs.docType, "INVOICE"),
        inArray(salesDocs.status, ["POSTED", "PARTIAL"]),
        sql`${salesDocs.grandTotal} > ${salesDocs.amountPaid} + ${salesDocs.returnedTotal} + ${salesDocs.writtenOffAmount}`
      )
    );
  const buckets: Record<AgingBucket, bigint> = {
    notDue: 0n,
    d30: 0n,
    d60: 0n,
    d90: 0n,
    d90plus: 0n,
  };
  let totalOutstanding = 0n;
  let maxDaysOverdue = 0;
  for (const r of rows) {
    const outstanding =
      r.grandTotal - r.amountPaid - r.returnedTotal - r.writtenOffAmount;
    if (outstanding <= 0n) continue;
    const d = daysOverdue(
      r.dueDate ? r.dueDate.getTime() : null,
      r.date.getTime(),
      nowMs
    );
    buckets[agingBucket(d)] += outstanding;
    totalOutstanding += outstanding;
    if (d > maxDaysOverdue) maxDaysOverdue = d;
  }
  return { buckets, totalOutstanding, maxDaysOverdue };
}

/**
 * Risk from the worst overdue bucket: 90+ days → HIGH, 31–90 → MEDIUM,
 * otherwise LOW. Pure function — easy to unit-test.
 */
export function computeRiskCategory(buckets: Record<AgingBucket, bigint>): RiskCategory {
  if (buckets.d90plus > 0n) return "HIGH";
  if (buckets.d60 > 0n || buckets.d90 > 0n) return "MEDIUM";
  return "LOW";
}

export interface HoldDecision {
  held: boolean;
  /** Human-readable reason (also stored on the party + audit event). */
  reason: string | null;
  risk: RiskCategory;
}

/**
 * Evaluate the company's credit rules against one party and apply the
 * resulting credit_status. Always refreshes risk_category. Writes a
 * credit_hold_events row only when the status actually flips.
 *
 * `actor` is the user id performing the evaluation, or "SYSTEM" for the
 * automatic rule engine (sales create / nightly sweep).
 */
export async function evaluateCreditHold(
  tx: DbTx,
  opts: { companyId: string; partyId: string; actor: string; nowMs?: number }
): Promise<HoldDecision> {
  const nowMs = opts.nowMs ?? Date.now();
  const partyRows = await tx
    .select({
      id: parties.id,
      name: parties.name,
      balance: parties.balance,
      creditLimit: parties.creditLimit,
      creditStatus: parties.creditStatus,
      creditHoldReason: parties.creditHoldReason,
    })
    .from(parties)
    .where(and(eq(parties.id, opts.partyId), eq(parties.companyId, opts.companyId)))
    .limit(1);
  const party = partyRows[0];
  if (!party) return { held: false, reason: null, risk: "LOW" };

  const rules = await getCreditRules(tx, opts.companyId);
  const aging = await partyAging(tx, opts.companyId, opts.partyId, nowMs);
  const risk = computeRiskCategory(aging.buckets);

  let reason: string | null = null;
  if (
    rules.blockIfOverdueDays != null &&
    rules.blockIfOverdueDays >= 0 &&
    aging.maxDaysOverdue > rules.blockIfOverdueDays
  ) {
    reason = `Invoice ${aging.maxDaysOverdue} days overdue (rule: block after ${rules.blockIfOverdueDays} days)`;
  }
  if (
    !reason &&
    rules.blockIfUtilizationPct != null &&
    rules.blockIfUtilizationPct >= 0
  ) {
    const u = creditUtilization(party.balance, party.creditLimit);
    if (u != null && u * 100 > rules.blockIfUtilizationPct) {
      reason = `Credit utilization ${Math.round(u * 100)}% exceeds ${rules.blockIfUtilizationPct}%`;
    }
  }

  const held = reason !== null;
  let newStatus: CreditStatus = held ? "HOLD" : "OK";
  const currentStatus = party.creditStatus as CreditStatus;
  if (!held && currentStatus === "HOLD") {
    // Manual holds are sticky: only an automatic (SYSTEM) hold clears
    // itself when the customer is back within the rules. A hold placed by
    // a person needs a person to release it.
    const last = await tx
      .select({ action: creditHoldEvents.action, createdById: creditHoldEvents.createdById })
      .from(creditHoldEvents)
      .where(and(eq(creditHoldEvents.companyId, opts.companyId), eq(creditHoldEvents.partyId, party.id)))
      .orderBy(sql`${creditHoldEvents.createdAt} DESC`)
      .limit(1);
    const lastHold = last[0];
    if (lastHold?.action === "HOLD" && lastHold.createdById !== "SYSTEM") {
      newStatus = "HOLD";
      reason = party.creditHoldReason ?? "Manual hold — release it explicitly.";
    }
  }
  const statusChanged = currentStatus !== newStatus;

  await tx
    .update(parties)
    .set({
      creditStatus: newStatus,
      riskCategory: risk,
      creditHoldReason: held ? reason : null,
      creditHoldAt: held ? new Date(nowMs) : null,
    })
    .where(eq(parties.id, party.id));

  if (statusChanged) {
    await tx.insert(creditHoldEvents).values({
      id: crypto.randomUUID(),
      companyId: opts.companyId,
      partyId: party.id,
      action: newStatus === "HOLD" ? "HOLD" : "RELEASE",
      reason,
      createdById: opts.actor,
    });
  }
  return { held: newStatus === "HOLD", reason, risk };
}

/**
 * Manual release of a credit hold. Requires a reason (audit). Also records
 * the release in the audit log via the caller (logAudit).
 */
export async function releaseCreditHold(
  tx: DbTx,
  opts: { companyId: string; partyId: string; reason: string; userId: string }
): Promise<void> {
  await tx
    .update(parties)
    .set({
      creditStatus: "OK",
      creditHoldReason: null,
      creditHoldAt: null,
    })
    .where(and(eq(parties.id, opts.partyId), eq(parties.companyId, opts.companyId)));
  await tx.insert(creditHoldEvents).values({
    id: crypto.randomUUID(),
    companyId: opts.companyId,
    partyId: opts.partyId,
    action: "RELEASE",
    reason: opts.reason,
    createdById: opts.userId,
  });
}

/**
 * Manual hold (e.g. from the receivables page). Requires a reason (audit).
 */
export async function placeCreditHold(
  tx: DbTx,
  opts: { companyId: string; partyId: string; reason: string; userId: string }
): Promise<void> {
  await tx
    .update(parties)
    .set({
      creditStatus: "HOLD",
      creditHoldReason: opts.reason,
      creditHoldAt: new Date(),
    })
    .where(and(eq(parties.id, opts.partyId), eq(parties.companyId, opts.companyId)));
  await tx.insert(creditHoldEvents).values({
    id: crypto.randomUUID(),
    companyId: opts.companyId,
    partyId: opts.partyId,
    action: "HOLD",
    reason: opts.reason,
    createdById: opts.userId,
  });
}

/**
 * Hard stop: throws CreditHoldError when the party is on hold. Call after
 * evaluateCreditHold (or on the fresh party row) before posting a credit
 * sale. Cash sales (newCreditPaisa <= 0) are never blocked — the customer
 * can always pay.
 */
export function assertCreditOk(
  party: { name: string; creditStatus: string; creditHoldReason: string | null; creditHoldAt: Date | null },
  opts?: { newCreditPaisa?: bigint }
): void {
  if ((opts?.newCreditPaisa ?? 1n) <= 0n) return;
  if (party.creditStatus === "HOLD") {
    throw new CreditHoldError({
      partyName: party.name,
      reason: party.creditHoldReason,
      since: party.creditHoldAt ? party.creditHoldAt.toISOString() : null,
    });
  }
}

export interface CollectionCandidate {
  partyId: string;
  partyName: string;
  phone: string | null;
  risk: RiskCategory;
  totalOutstanding: string;
  maxDaysOverdue: number;
  onHold: boolean;
}

/**
 * Payment-priority suggestions: customers with open invoices, ranked so the
 * collector calls the riskiest money first — HIGH risk before MEDIUM before
 * LOW, then oldest overdue first, then largest outstanding first.
 * Serialized paisa as strings (client-safe).
 */
export async function collectionPriority(
  tx: Db | DbTx,
  companyId: string,
  nowMs = Date.now()
): Promise<CollectionCandidate[]> {
  const customerRows = await tx
    .select({
      id: parties.id,
      name: parties.name,
      phone: parties.phone,
      creditStatus: parties.creditStatus,
    })
    .from(parties)
    .where(
      and(
        eq(parties.companyId, companyId),
        eq(parties.kind, "CUSTOMER"),
        eq(parties.isActive, true)
      )
    );
  const out: CollectionCandidate[] = [];
  for (const c of customerRows) {
    const aging = await partyAging(tx, companyId, c.id, nowMs);
    if (aging.totalOutstanding <= 0n) continue;
    out.push({
      partyId: c.id,
      partyName: c.name,
      phone: c.phone,
      risk: computeRiskCategory(aging.buckets),
      totalOutstanding: aging.totalOutstanding.toString(),
      maxDaysOverdue: aging.maxDaysOverdue,
      onHold: c.creditStatus === "HOLD",
    });
  }
  const rank: Record<RiskCategory, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  out.sort(
    (a, b) =>
      rank[a.risk] - rank[b.risk] ||
      b.maxDaysOverdue - a.maxDaysOverdue ||
      Number(BigInt(b.totalOutstanding) - BigInt(a.totalOutstanding))
  );
  return out;
}
