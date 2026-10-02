/**
 * Module 24 — Recurring invoices & subscriptions.
 *
 * A template bills one customer on a schedule (DAILY / WEEKLY / MONTHLY /
 * QUARTERLY / YEARLY) between start_date and end_date. The scheduler
 * (runDueTemplates, driven by /api/cron/recurring) generates a real sales
 * invoice per due period through the normal sales-posting core:
 * lib/posting.ts postSalesDoc (balanced Dr==Cr journal, stock moves with
 * batch/FIFO lineage), lib/credit-limit.ts enforcement, and the Module 23
 * credit-hold engine.
 *
 * Idempotency: recurring_runs has UNIQUE(template_id, period_start), so a
 * period can never be generated twice even if two cron workers race — the
 * loser hits the unique constraint and rolls back. Templates also stamp
 * sales_docs.idempotency_key = "recurring:<templateId>:<periodMs>" as a
 * second guard via the existing partial unique index.
 *
 * Safety rails in the scheduler: a due run is NOT auto-posted when the
 * period is locked, when the customer is on credit hold, when the credit
 * limit would be breached, or when an approval rule stages over-threshold
 * invoices — those runs are recorded as FAILED/SKIPPED with a reason and
 * retried (or handled) later. The scheduler never stages approvals itself.
 *
 * Money is integer paisa (bigint) throughout. All queries scoped by
 * companyId. Dates are UTC-midnight millis; month arithmetic clamps to the
 * end of shorter months (Jan 31 → Feb 28).
 */
import { and, asc, desc, eq, lte } from "drizzle-orm";
import {
  parties,
  products,
  recurringRuns,
  recurringTemplates,
  salesDocs,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { postSalesDoc, type PostSalesInput } from "./posting";
import { nextDocNo } from "./setup";
import { taxOf } from "./doc-math";
import { periodLockError } from "./period";
import { approvalRequired } from "./approvals";
import {
  enforceCreditLimit,
  CreditLimitError,
  newUdhaarForInvoice,
} from "./credit-limit";
import { evaluateCreditHold } from "./credit-control";

export const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "QUARTERLY", "YEARLY"] as const;
export type Frequency = (typeof FREQUENCIES)[number];
export type TemplateStatus = "ACTIVE" | "PAUSED" | "COMPLETED";
export type RunStatus = "GENERATED" | "SKIPPED" | "FAILED";

export interface TemplateItem {
  productId: string;
  /** Whole base units (must be > 0). */
  qty: number;
  /** Paisa per base unit (snapshot at template creation; >= 0). */
  ratePaisa: string;
}

const DAY_MS = 86_400_000;

/** Next run date for a frequency. Pure function — unit-tested. */
export function advanceRunDate(fromMs: number, frequency: Frequency): number {
  const d = new Date(fromMs);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  const day = d.getUTCDate();
  switch (frequency) {
    case "DAILY":
      return fromMs + DAY_MS;
    case "WEEKLY":
      return fromMs + 7 * DAY_MS;
    case "MONTHLY":
    case "QUARTERLY":
    case "YEARLY": {
      const addMonths = frequency === "MONTHLY" ? 1 : frequency === "QUARTERLY" ? 3 : 12;
      // Clamp to the last day of the target month (Jan 31 → Feb 28/29).
      const lastDay = new Date(Date.UTC(y, m + addMonths + 1, 0)).getUTCDate();
      return Date.UTC(y, m + addMonths, Math.min(day, lastDay));
    }
  }
}

/** Parse + validate the items JSON stored on a template. */
export function parseTemplateItems(json: string): TemplateItem[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new UserError("Recurring template items are corrupt.", 422, "INVALID_TEMPLATE");
  }
  if (!Array.isArray(raw) || raw.length === 0)
    throw new UserError("A recurring template needs at least one item.", 422, "INVALID_TEMPLATE");
  return raw.map((it, i) => {
    const o = it as Record<string, unknown>;
    const productId = String(o.productId ?? "");
    const qty = Number(o.qty);
    let ratePaisa = 0n;
    try {
      ratePaisa = BigInt(String(o.ratePaisa ?? "0"));
    } catch {
      throw new UserError(`Item ${i + 1}: invalid rate.`, 422, "INVALID_TEMPLATE");
    }
    if (!productId) throw new UserError(`Item ${i + 1}: product is required.`, 422, "INVALID_TEMPLATE");
    if (!Number.isInteger(qty) || qty <= 0)
      throw new UserError(`Item ${i + 1}: quantity must be a positive whole number.`, 422, "INVALID_TEMPLATE");
    if (ratePaisa < 0n) throw new UserError(`Item ${i + 1}: rate cannot be negative.`, 422, "INVALID_TEMPLATE");
    return { productId, qty, ratePaisa: ratePaisa.toString() };
  });
}

export interface TemplateInput {
  branchId: string;
  partyId: string;
  name: string;
  frequency: Frequency;
  startDateMs: number;
  endDateMs: number | null;
  terms?: string | null;
  notes?: string | null;
  items: TemplateItem[];
}

async function resolveTemplateParty(tx: Db | DbTx, companyId: string, partyId: string) {
  const rows = await tx
    .select({ id: parties.id, name: parties.name, kind: parties.kind, isActive: parties.isActive })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p || p.kind !== "CUSTOMER" || !p.isActive)
    throw new UserError("Choose an active customer for the recurring template.", 422, "INVALID_TEMPLATE");
  return p;
}

async function resolveTemplateProducts(tx: Db | DbTx, companyId: string, items: TemplateItem[]) {
  const ids = [...new Set(items.map((i) => i.productId))];
  const rows = await tx
    .select({
      id: products.id,
      name: products.name,
      trackStock: products.trackStock,
      taxBps: products.taxBps,
      isActive: products.isActive,
    })
    .from(products)
    .where(and(eq(products.companyId, companyId)));
  const map = new Map(rows.filter((r) => ids.includes(r.id)).map((r) => [r.id, r]));
  for (const it of items) {
    const p = map.get(it.productId);
    if (!p) throw new UserError("One of the template products no longer exists.", 422, "INVALID_TEMPLATE");
    if (!p.isActive) throw new UserError(`"${p.name}" is inactive and cannot be billed.`, 422, "INVALID_TEMPLATE");
  }
  return map;
}

export async function createRecurringTemplate(
  tx: DbTx,
  companyId: string,
  input: TemplateInput,
  createdById: string
): Promise<string> {
  if (!FREQUENCIES.includes(input.frequency))
    throw new UserError("Invalid frequency.", 422, "INVALID_TEMPLATE");
  if (!input.name.trim()) throw new UserError("Template name is required.", 422, "INVALID_TEMPLATE");
  if (input.endDateMs != null && input.endDateMs < input.startDateMs)
    throw new UserError("End date cannot be before the start date.", 422, "INVALID_TEMPLATE");
  await resolveTemplateParty(tx, companyId, input.partyId);
  await resolveTemplateProducts(tx, companyId, input.items);
  const id = crypto.randomUUID();
  const now = new Date();
  await tx.insert(recurringTemplates).values({
    id,
    companyId,
    branchId: input.branchId,
    partyId: input.partyId,
    name: input.name.trim(),
    frequency: input.frequency,
    startDate: new Date(input.startDateMs),
    endDate: input.endDateMs != null ? new Date(input.endDateMs) : null,
    nextRunDate: new Date(input.startDateMs),
    status: "ACTIVE",
    terms: input.terms?.trim() || null,
    notes: input.notes?.trim() || null,
    itemsJson: JSON.stringify(input.items),
    skipNext: false,
    createdById,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export async function updateRecurringTemplate(
  tx: DbTx,
  companyId: string,
  templateId: string,
  input: Partial<TemplateInput>
): Promise<void> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t) throw new UserError("Recurring template not found.", 404, "NOT_FOUND");
  if (t.status === "COMPLETED")
    throw new UserError("A completed template cannot be edited.", 422, "INVALID_TEMPLATE");
  const patch: Partial<typeof recurringTemplates.$inferInsert> = { updatedAt: new Date() };
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new UserError("Template name is required.", 422, "INVALID_TEMPLATE");
    patch.name = input.name.trim();
  }
  if (input.frequency !== undefined) {
    if (!FREQUENCIES.includes(input.frequency)) throw new UserError("Invalid frequency.", 422, "INVALID_TEMPLATE");
    patch.frequency = input.frequency;
  }
  if (input.partyId !== undefined) {
    await resolveTemplateParty(tx, companyId, input.partyId);
    patch.partyId = input.partyId;
  }
  if (input.items !== undefined) {
    await resolveTemplateProducts(tx, companyId, input.items);
    patch.itemsJson = JSON.stringify(input.items);
  }
  if (input.endDateMs !== undefined) patch.endDate = input.endDateMs != null ? new Date(input.endDateMs) : null;
  if (input.terms !== undefined) patch.terms = input.terms?.trim() || null;
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
  await tx.update(recurringTemplates).set(patch).where(eq(recurringTemplates.id, templateId));
}

export async function getTemplate(tx: Db | DbTx, companyId: string, templateId: string) {
  const rows = await tx
    .select()
    .from(recurringTemplates)
    .where(and(eq(recurringTemplates.id, templateId), eq(recurringTemplates.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listTemplates(tx: Db | DbTx, companyId: string) {
  return tx
    .select({
      template: recurringTemplates,
      partyName: parties.name,
    })
    .from(recurringTemplates)
    .innerJoin(parties, eq(recurringTemplates.partyId, parties.id))
    .where(eq(recurringTemplates.companyId, companyId))
    .orderBy(desc(recurringTemplates.createdAt));
}

export async function setTemplateStatus(
  tx: DbTx,
  companyId: string,
  templateId: string,
  status: "ACTIVE" | "PAUSED"
): Promise<void> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t) throw new UserError("Recurring template not found.", 404, "NOT_FOUND");
  if (t.status === "COMPLETED")
    throw new UserError("A completed template cannot be resumed.", 422, "INVALID_TEMPLATE");
  await tx
    .update(recurringTemplates)
    .set({ status, updatedAt: new Date() })
    .where(eq(recurringTemplates.id, templateId));
}

/** Skip the next scheduled run: the scheduler advances next_run_date without generating. */
export async function skipNextRun(tx: DbTx, companyId: string, templateId: string): Promise<void> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t) throw new UserError("Recurring template not found.", 404, "NOT_FOUND");
  if (t.status !== "ACTIVE")
    throw new UserError("Only an active template can skip its next run.", 422, "INVALID_TEMPLATE");
  await tx
    .update(recurringTemplates)
    .set({ skipNext: true, updatedAt: new Date() })
    .where(eq(recurringTemplates.id, templateId));
}

export async function deleteTemplate(tx: DbTx, companyId: string, templateId: string): Promise<void> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t) throw new UserError("Recurring template not found.", 404, "NOT_FOUND");
  await tx.delete(recurringRuns).where(eq(recurringRuns.templateId, templateId));
  await tx.delete(recurringTemplates).where(eq(recurringTemplates.id, templateId));
}

export async function templateRuns(tx: Db | DbTx, companyId: string, templateId: string, limit = 50) {
  return tx
    .select({ run: recurringRuns, docNo: salesDocs.docNo })
    .from(recurringRuns)
    .leftJoin(salesDocs, eq(recurringRuns.salesDocId, salesDocs.id))
    .where(and(eq(recurringRuns.companyId, companyId), eq(recurringRuns.templateId, templateId)))
    .orderBy(desc(recurringRuns.periodStart))
    .limit(limit);
}

// ─── Scheduler ───────────────────────────────────────────────────

export interface RunSummary {
  templates: number;
  generated: number;
  skipped: number;
  failed: number;
  failures: { templateId: string; name: string; reason: string }[];
}

/**
 * Generate invoices for every ACTIVE template whose next_run_date is due.
 * Each template runs in its own transaction so one bad template never
 * blocks the rest. Idempotent: UNIQUE(template_id, period_start) means a
 * re-run of the same period is a no-op.
 */
export async function runDueTemplates(
  dbc: Db,
  opts: { companyId: string; asOfMs?: number; actor?: string }
): Promise<RunSummary> {
  const asOfMs = opts.asOfMs ?? Date.now();
  const actor = opts.actor ?? "SYSTEM";
  const due = await dbc
    .select()
    .from(recurringTemplates)
    .where(
      and(
        eq(recurringTemplates.companyId, opts.companyId),
        eq(recurringTemplates.status, "ACTIVE"),
        lte(recurringTemplates.nextRunDate, new Date(asOfMs))
      )
    )
    .orderBy(asc(recurringTemplates.nextRunDate));

  const summary: RunSummary = { templates: due.length, generated: 0, skipped: 0, failed: 0, failures: [] };
  for (const t of due) {
    try {
      // Step 1 (committed on its own): refresh the credit-hold state and
      // decide whether this period may be generated at all. Retryable
      // failures (hold, lock, limit, approval) throw here or in step 2 —
      // the period row is NOT written, so the next cron run retries.
      const decision = await dbc.transaction((tx) => preflightTemplate(tx, opts.companyId, t.id, asOfMs, actor));
      if (decision.verdict === "SKIP") {
        summary.skipped++;
        continue;
      }
      // Step 2 (one txn): generate the invoice + GENERATED run row + cursor.
      await dbc.transaction((tx) => generateTemplateInvoice(tx, opts.companyId, t.id, decision.periodMs, asOfMs));
      summary.generated++;
    } catch (e) {
      // Unique-violation on (template_id, period_start) = another worker won
      // the race; count it as a skip, not a failure.
      if (isUniqueViolation(e)) {
        summary.skipped++;
        continue;
      }
      summary.failed++;
      summary.failures.push({
        templateId: t.id,
        name: t.name,
        reason: e instanceof Error ? e.message : "Unknown error",
      });
    }
  }
  return summary;
}

function isUniqueViolation(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /UNIQUE constraint failed|unique/i.test(msg);
}

type Preflight = { verdict: "SKIP" } | { verdict: "GENERATE"; periodMs: number };

/**
 * Step 1: re-read the template, honour skip_next, refresh the party's
 * credit-hold state (committed), and decide. Never writes a run row, so a
 * failure here simply retries on the next cron tick.
 */
async function preflightTemplate(
  tx: DbTx,
  companyId: string,
  templateId: string,
  asOfMs: number,
  actor: string
): Promise<Preflight> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t || t.status !== "ACTIVE" || t.nextRunDate.getTime() > asOfMs) return { verdict: "SKIP" };
  const periodMs = t.nextRunDate.getTime();

  // Idempotency: this period was already handled — move the cursor past it.
  const existing = await tx
    .select({ id: recurringRuns.id })
    .from(recurringRuns)
    .where(and(eq(recurringRuns.templateId, templateId), eq(recurringRuns.periodStart, new Date(periodMs))))
    .limit(1);
  if (existing[0]) {
    await advanceCursor(tx, templateId, t.frequency as Frequency, t.endDate, periodMs);
    return { verdict: "SKIP" };
  }

  // skip_next: record the skip in history, advance, invoice nothing.
  if (t.skipNext) {
    await tx.insert(recurringRuns).values({
      id: crypto.randomUUID(),
      companyId,
      templateId,
      periodStart: new Date(periodMs),
      salesDocId: null,
      status: "SKIPPED",
      detail: "Skipped by user (skip next run).",
    });
    await tx
      .update(recurringTemplates)
      .set({ skipNext: false, lastRunAt: new Date(asOfMs), updatedAt: new Date() })
      .where(eq(recurringTemplates.id, templateId));
    await advanceCursor(tx, templateId, t.frequency as Frequency, t.endDate, periodMs);
    return { verdict: "SKIP" };
  }

  // Credit hard stop BEFORE anything is invoiced (committed even if the
  // generation txn below rolls back — the hold is real either way).
  const hold = await evaluateCreditHold(tx, { companyId, partyId: t.partyId, actor, nowMs: asOfMs });
  if (hold.held) {
    throw new UserError(`Customer is on credit hold: ${hold.reason}`, 409, "CREDIT_ON_HOLD");
  }
  return { verdict: "GENERATE", periodMs };
}

/**
 * Step 2: build the invoice from the template snapshot and post it through
 * the normal sales core (balanced journal + stock moves + credit-limit
 * enforcement). The run row is inserted FIRST so a racing worker hits the
 * UNIQUE(template_id, period_start) guard before doing any work.
 */
async function generateTemplateInvoice(
  tx: DbTx,
  companyId: string,
  templateId: string,
  periodMs: number,
  asOfMs: number
): Promise<void> {
  const t = await getTemplate(tx, companyId, templateId);
  if (!t || t.status !== "ACTIVE") throw new UserError("Template is no longer active.", 422, "INVALID_TEMPLATE");

  const docDate = new Date(periodMs);
  const lockErr = await periodLockError(tx, companyId, docDate);
  if (lockErr) throw new UserError(`Period locked: ${lockErr}`, 422, "PERIOD_LOCKED");

  const items = parseTemplateItems(t.itemsJson);
  const prodMap = await resolveTemplateProducts(tx, companyId, items);

  // Build line items from the template snapshot (rate frozen at creation).
  const computed: PostSalesInput["items"] = items.map((it) => {
    const p = prodMap.get(it.productId)!;
    const ratePaisa = BigInt(it.ratePaisa);
    const qtyMilli = BigInt(it.qty) * 1000n;
    const grossPaisa = (qtyMilli * ratePaisa) / 1000n;
    const taxablePaisa = grossPaisa;
    const taxAmountPaisa = taxOf(taxablePaisa, p.taxBps);
    return {
      productId: it.productId,
      description: p.name,
      qtyMilli,
      ratePaisa,
      discountPaisa: 0n,
      taxBps: p.taxBps,
      grossPaisa,
      taxablePaisa,
      taxAmountPaisa,
      lineTotalPaisa: taxablePaisa + taxAmountPaisa,
      trackStock: p.trackStock,
      batchId: null,
      branchId: null,
    };
  });
  const subtotal = computed.reduce((a, i) => a + i.grossPaisa, 0n);
  const taxTotal = computed.reduce((a, i) => a + i.taxAmountPaisa, 0n);
  const grandTotal = subtotal + taxTotal;
  if (grandTotal <= 0n)
    throw new UserError("Recurring template total is zero — nothing to invoice.", 422, "INVALID_TEMPLATE");

  // Approval staging is a human workflow; the scheduler never stages — it
  // refuses, so the owner creates the invoice manually.
  if (await approvalRequired(tx, companyId, "SALES_INVOICE", grandTotal))
    throw new UserError("Invoice needs approval — create it manually.", 422, "APPROVAL_REQUIRED");

  // Same hard stop as the sales route: unpaid remainder vs the limit.
  await enforceCreditLimit(tx, {
    companyId,
    partyId: t.partyId,
    newCreditPaisa: newUdhaarForInvoice({ grandTotalPaisa: grandTotal, advanceAppliedPaisa: 0n, receiptAllocatedPaisa: 0n }),
  });

  // Claim the period first — the UNIQUE guard makes double-generation
  // impossible even under a race.
  const runId = crypto.randomUUID();
  await tx.insert(recurringRuns).values({
    id: runId,
    companyId,
    templateId,
    periodStart: new Date(periodMs),
    salesDocId: null,
    status: "GENERATED",
    detail: null,
  });

  const docNo = await nextDocNo(tx, companyId, "INVOICE");
  const docId = crypto.randomUUID();
  await tx.insert(salesDocs).values({
    id: docId,
    companyId,
    branchId: t.branchId,
    partyId: t.partyId,
    docType: "INVOICE",
    docNo,
    date: docDate,
    dueDate: null,
    terms: t.terms,
    notes: t.notes ? `Recurring: ${t.name}\n${t.notes}` : `Recurring: ${t.name}`,
    status: "POSTED",
    subtotal,
    discountTotal: 0n,
    taxTotal,
    freightTotal: 0n,
    grandTotal,
    idempotencyKey: `recurring:${templateId}:${periodMs}`,
    createdById: t.createdById,
  });
  const entryId = await postSalesDoc(tx, {
    companyId,
    branchId: t.branchId,
    partyId: t.partyId,
    docId,
    docNo,
    docType: "INVOICE",
    date: docDate,
    items: computed,
    discountTotal: 0n,
    taxTotal,
    grandTotal,
    createdById: t.createdById,
  });
  await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));

  await tx
    .update(recurringRuns)
    .set({ salesDocId: docId, detail: `Invoice ${docNo}` })
    .where(eq(recurringRuns.id, runId));
  await tx
    .update(recurringTemplates)
    .set({ lastRunAt: new Date(asOfMs), updatedAt: new Date() })
    .where(eq(recurringTemplates.id, templateId));
  await advanceCursor(tx, templateId, t.frequency as Frequency, t.endDate, periodMs);
}

/** Move next_run_date forward; COMPLETED when it passes end_date. */
async function advanceCursor(
  tx: DbTx,
  templateId: string,
  frequency: Frequency,
  endDate: Date | null,
  periodMs: number
): Promise<void> {
  const next = advanceRunDate(periodMs, frequency);
  const done = endDate != null && next > endDate.getTime();
  await tx
    .update(recurringTemplates)
    .set({
      nextRunDate: new Date(next),
      status: done ? "COMPLETED" : "ACTIVE",
      updatedAt: new Date(),
    })
    .where(eq(recurringTemplates.id, templateId));
}

/**
 * Serialize a recurring template row for API responses.
 * Pure formatter — lives here (not in route.ts) so both the collection and
 * [id] routes can share it; route files may only export HTTP handlers.
 */
export function serializeTemplate(
  t: {
    id: string;
    branchId: string;
    partyId: string;
    name: string;
    frequency: string;
    startDate: Date;
    endDate: Date | null;
    nextRunDate: Date;
    status: string;
    terms: string | null;
    notes: string | null;
    itemsJson: string;
    skipNext: boolean;
    lastRunAt: Date | null;
    createdAt: Date;
  },
  partyName: string
) {
  return {
    id: t.id,
    branchId: t.branchId,
    partyId: t.partyId,
    partyName,
    name: t.name,
    frequency: t.frequency,
    startDate: t.startDate.toISOString(),
    endDate: t.endDate?.toISOString() ?? null,
    nextRunDate: t.nextRunDate.toISOString(),
    status: t.status,
    terms: t.terms,
    notes: t.notes,
    items: JSON.parse(t.itemsJson) as TemplateItem[],
    skipNext: t.skipNext,
    lastRunAt: t.lastRunAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}
