// Module 13 — Projects & Job Costing.
//
//   * Project master (code PRJ-0001 per company, customer link, dates,
//     contract value, budget, status).
//   * Project tagging: project_id on sales/purchase/expense/payment docs +
//     journal lines. Tagging never changes the journal balance — the tag
//     rides on lines (see withProject in lib/posting.ts).
//   * Job costing: the project P&L is computed from tagged journal lines
//     classified by GL account type (INCOME → revenue, EXPENSE → cost).
//     WIP-by-project reuses Manufacturing's 1250 WIP account sliced by the
//     project tag (documented in docs/module13-projects.md).
//
// Deliberately out of scope: timesheets, progress billing, retention,
// subcontractor masters. Payroll's labor cost is an aggregate — it carries no
// project tag (boundary: tag labor onto a project with a manual JV).
import { eq, and, desc, gte, lte } from "drizzle-orm";
import { projects, parties, journalEntries, journalLines, accounts, salesDocs, purchaseDocs, expenses, payments } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { nextDocNo, SYS } from "./setup";
import { UserError } from "./errors";

type Dbx = Db | DbTx;

export const PROJECT_STATUSES = ["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** Statuses a document/journal may be tagged against. CANCELLED never. */
export const TAGGABLE_STATUSES: readonly ProjectStatus[] = ["ACTIVE", "ON_HOLD", "COMPLETED"];

const TERMINAL: readonly ProjectStatus[] = ["COMPLETED", "CANCELLED"];

/** Allowed status moves. Terminal statuses never move again. */
const TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  ACTIVE: ["ON_HOLD", "COMPLETED", "CANCELLED"],
  ON_HOLD: ["ACTIVE", "COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
};

export type ProjectRow = typeof projects.$inferSelect;

/* ── Guards ────────────────────────────────────────────────────────── */

export async function getProject(tx: Dbx, companyId: string, projectId: string): Promise<ProjectRow> {
  const [p] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.companyId, companyId)))
    .limit(1);
  if (!p) throw new UserError("Project not found.", 404, "PROJECT_NOT_FOUND");
  return p;
}

/**
 * Validate a project tag for a new document/journal line. The project must
 * belong to the company and must not be CANCELLED. Returns the id (or null
 * for untagged) so callers can store it verbatim.
 */
export async function validateProjectId(
  tx: Dbx,
  companyId: string,
  projectId: string | null | undefined
): Promise<string | null> {
  if (!projectId) return null;
  const p = await getProject(tx, companyId, projectId);
  if (!TAGGABLE_STATUSES.includes(p.status as ProjectStatus))
    throw new UserError(
      `Project ${p.code} is ${p.status.toLowerCase().replace("_", " ")} — it can no longer be tagged.`,
      422,
      "PROJECT_CANCELLED"
    );
  return p.id;
}

/* ── Create / update ───────────────────────────────────────────────── */

export type CreateProjectInput = {
  companyId: string;
  name: string;
  customerId?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  contractValuePaisa?: bigint;
  budgetPaisa?: bigint;
  notes?: string | null;
  createdById: string;
};

export async function createProject(tx: Dbx, input: CreateProjectInput): Promise<ProjectRow> {
  const name = (input.name || "").trim();
  if (!name) throw new UserError("Project name is required.", 422, "PROJECT_NAME_REQUIRED");
  if (name.length > 120) throw new UserError("Project name is too long.", 422, "PROJECT_NAME_LONG");
  if (input.contractValuePaisa != null && input.contractValuePaisa < 0n)
    throw new UserError("Contract value cannot be negative.", 422, "PROJECT_NEG_CONTRACT");
  if (input.budgetPaisa != null && input.budgetPaisa < 0n)
    throw new UserError("Budget cannot be negative.", 422, "PROJECT_NEG_BUDGET");
  if (input.startDate && input.endDate && input.endDate < input.startDate)
    throw new UserError("End date cannot be before the start date.", 422, "PROJECT_BAD_DATES");

  let customerId: string | null = null;
  if (input.customerId) {
    const [c] = await tx
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, input.customerId), eq(parties.companyId, input.companyId)))
      .limit(1);
    if (!c) throw new UserError("Customer not found in this company.", 404, "PROJECT_CUSTOMER_NOT_FOUND");
    customerId = c.id;
  }

  const code = await nextDocNo(tx as DbTx, input.companyId, "PROJECT");
  const id = crypto.randomUUID();
  await tx.insert(projects).values({
    id,
    companyId: input.companyId,
    code,
    name,
    customerId,
    startDate: input.startDate ?? null,
    endDate: input.endDate ?? null,
    contractValue: input.contractValuePaisa ?? 0n,
    budget: input.budgetPaisa ?? 0n,
    status: "ACTIVE",
    notes: input.notes?.trim() || null,
    createdById: input.createdById,
  });
  const [row] = await tx.select().from(projects).where(eq(projects.id, id)).limit(1);
  return row!;
}

export type UpdateProjectInput = {
  name?: string;
  customerId?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  contractValuePaisa?: bigint;
  budgetPaisa?: bigint;
  status?: ProjectStatus;
  notes?: string | null;
};

export async function updateProject(
  tx: Dbx,
  companyId: string,
  projectId: string,
  input: UpdateProjectInput
): Promise<ProjectRow> {
  const p = await getProject(tx, companyId, projectId);
  const patch: Partial<typeof projects.$inferInsert> = {};

  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new UserError("Project name is required.", 422, "PROJECT_NAME_REQUIRED");
    if (name.length > 120) throw new UserError("Project name is too long.", 422, "PROJECT_NAME_LONG");
    patch.name = name;
  }
  if (input.customerId !== undefined) {
    if (input.customerId) {
      const [c] = await tx
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.id, input.customerId), eq(parties.companyId, companyId)))
        .limit(1);
      if (!c) throw new UserError("Customer not found in this company.", 404, "PROJECT_CUSTOMER_NOT_FOUND");
      patch.customerId = c.id;
    } else {
      patch.customerId = null;
    }
  }
  const startDate = input.startDate !== undefined ? input.startDate : p.startDate;
  const endDate = input.endDate !== undefined ? input.endDate : p.endDate;
  if (startDate && endDate && endDate < startDate)
    throw new UserError("End date cannot be before the start date.", 422, "PROJECT_BAD_DATES");
  if (input.startDate !== undefined) patch.startDate = input.startDate;
  if (input.endDate !== undefined) patch.endDate = input.endDate;
  if (input.contractValuePaisa !== undefined) {
    if (input.contractValuePaisa < 0n) throw new UserError("Contract value cannot be negative.", 422, "PROJECT_NEG_CONTRACT");
    patch.contractValue = input.contractValuePaisa;
  }
  if (input.budgetPaisa !== undefined) {
    if (input.budgetPaisa < 0n) throw new UserError("Budget cannot be negative.", 422, "PROJECT_NEG_BUDGET");
    patch.budget = input.budgetPaisa;
  }
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  if (input.status !== undefined && input.status !== p.status) {
    if (!PROJECT_STATUSES.includes(input.status))
      throw new UserError("Unknown project status.", 422, "PROJECT_BAD_STATUS");
    if (TERMINAL.includes(p.status as ProjectStatus))
      throw new UserError(
        `A ${p.status.toLowerCase()} project cannot change status.`,
        409,
        "PROJECT_STATUS_TERMINAL"
      );
    if (!TRANSITIONS[p.status as ProjectStatus].includes(input.status))
      throw new UserError(
        `Cannot move a project from ${p.status} to ${input.status}.`,
        422,
        "PROJECT_BAD_TRANSITION"
      );
    patch.status = input.status;
  }

  if (Object.keys(patch).length > 0) {
    await tx.update(projects).set(patch).where(eq(projects.id, projectId));
  }
  const [row] = await tx.select().from(projects).where(eq(projects.id, projectId)).limit(1);
  return row!;
}

/* ── Listing ───────────────────────────────────────────────────────── */

export type ProjectListRow = ProjectRow & { customerName: string | null };

export async function listProjects(
  tx: Dbx,
  companyId: string,
  status?: ProjectStatus
): Promise<ProjectListRow[]> {
  const conds = [eq(projects.companyId, companyId)];
  if (status) {
    if (!PROJECT_STATUSES.includes(status)) throw new UserError("Unknown project status.", 422, "PROJECT_BAD_STATUS");
    conds.push(eq(projects.status, status));
  }
  const rows = await tx
    .select({ p: projects, customerName: parties.name })
    .from(projects)
    .leftJoin(parties, eq(projects.customerId, parties.id))
    .where(and(...conds))
    .orderBy(desc(projects.createdAt));
  return rows.map((r) => ({ ...r.p, customerName: r.customerName }));
}

/* ── Job costing: project P&L ────────────────────────────────────────
 *
 * Single source of truth: tagged journal lines (project_id), joined to
 * journal_entries for the company + entry-date range, classified by the GL
 * account's type:
 *   INCOME  → revenue += credit − debit   (sales returns debit INCOME, so
 *                                          they reduce revenue naturally)
 *   EXPENSE → cost    += debit − credit    (COGS, discounts given, expenses)
 * Anything else (AR/AP/Bank/Inventory/Tax/WIP) never touches the P&L — it is
 * balance-sheet movement, which is ledger-correct. Voids post mirror-image
 * reversing journals WITH the project tag, so voided docs net to zero.
 */

export type ProjectCostLine = {
  code: string;
  name: string;
  /** Net cost on this account (debits − credits), paisa. */
  amount: bigint;
};

export type ProjectPL = {
  projectId: string;
  code: string;
  name: string;
  status: ProjectStatus;
  from: string | null;
  to: string | null;
  /** Revenue (INCOME accounts, credits − debits), paisa. */
  revenue: bigint;
  /** Total direct cost (EXPENSE accounts, debits − credits), paisa. */
  cost: bigint;
  /** revenue − cost, paisa. */
  profit: bigint;
  /** Costs broken down by GL account. */
  costByAccount: ProjectCostLine[];
  /** WIP-by-project: tagged lines on the 1250 WIP account (Dr − Cr), paisa.
   *  Manufacturing's WIP account sliced by the project tag. */
  wip: bigint;
};

export async function projectPL(
  tx: Dbx,
  companyId: string,
  projectId: string,
  from?: Date | null,
  to?: Date | null
): Promise<ProjectPL> {
  const p = await getProject(tx, companyId, projectId);
  const conds = [
    eq(journalEntries.companyId, companyId),
    eq(journalLines.projectId, projectId),
  ];
  if (from) conds.push(gte(journalEntries.date, from));
  if (to) conds.push(lte(journalEntries.date, to));

  const rows = await tx
    .select({
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      debit: journalLines.debit,
      credit: journalLines.credit,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(and(...conds));

  let revenue = 0n;
  let cost = 0n;
  let wip = 0n;
  const byAccount = new Map<string, ProjectCostLine>();
  for (const r of rows) {
    const d = BigInt(r.debit);
    const c = BigInt(r.credit);
    if (r.type === "INCOME") {
      revenue += c - d;
    } else if (r.type === "EXPENSE") {
      const net = d - c;
      cost += net;
      const key = r.code;
      const prev = byAccount.get(key);
      if (prev) prev.amount += net;
      else byAccount.set(key, { code: r.code, name: r.name, amount: net });
    }
    if (r.code === SYS.WIP) wip += d - c;
  }

  return {
    projectId: p.id,
    code: p.code,
    name: p.name,
    status: p.status as ProjectStatus,
    from: from ? from.toISOString() : null,
    to: to ? to.toISOString() : null,
    revenue,
    cost,
    profit: revenue - cost,
    costByAccount: [...byAccount.values()].sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0)),
    wip,
  };
}

/* ── Tagged documents (for the detail page) ────────────────────────── */

export type TaggedDoc = {
  kind: "SALE" | "PURCHASE" | "EXPENSE" | "PAYMENT";
  id: string;
  docNo: string;
  date: number;
  total: bigint;
  partyName: string | null;
};

/**
 * Every document carrying the project tag (any status/date — the list is
 * for traceability; the P&L is what respects the date range). Ordered
 * newest-first.
 */
export async function taggedDocs(tx: Dbx, companyId: string, projectId: string): Promise<TaggedDoc[]> {
  const out: TaggedDoc[] = [];

  const s = await tx
    .select({ id: salesDocs.id, docNo: salesDocs.docNo, date: salesDocs.date, total: salesDocs.grandTotal, partyName: parties.name })
    .from(salesDocs)
    .leftJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(eq(salesDocs.companyId, companyId), eq(salesDocs.projectId, projectId)))
    .orderBy(desc(salesDocs.date));
  for (const r of s)
    out.push({ kind: "SALE", id: r.id, docNo: r.docNo, date: dateMs(r.date), total: BigInt(r.total), partyName: r.partyName });

  const pu = await tx
    .select({ id: purchaseDocs.id, docNo: purchaseDocs.docNo, date: purchaseDocs.date, total: purchaseDocs.grandTotal, partyName: parties.name })
    .from(purchaseDocs)
    .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(eq(purchaseDocs.companyId, companyId), eq(purchaseDocs.projectId, projectId)))
    .orderBy(desc(purchaseDocs.date));
  for (const r of pu)
    out.push({ kind: "PURCHASE", id: r.id, docNo: r.docNo, date: dateMs(r.date), total: BigInt(r.total), partyName: r.partyName });

  const e = await tx
    .select({ id: expenses.id, docNo: expenses.docNo, date: expenses.date, amount: expenses.amount, taxAmount: expenses.taxAmount })
    .from(expenses)
    .where(and(eq(expenses.companyId, companyId), eq(expenses.projectId, projectId)))
    .orderBy(desc(expenses.date));
  for (const r of e)
    out.push({ kind: "EXPENSE", id: r.id, docNo: r.docNo ?? "", date: dateMs(r.date), total: BigInt(r.amount) + BigInt(r.taxAmount), partyName: null });

  const pay = await tx
    .select({ id: payments.id, docNo: payments.docNo, date: payments.date, total: payments.amount, partyName: parties.name })
    .from(payments)
    .leftJoin(parties, eq(payments.partyId, parties.id))
    .where(and(eq(payments.companyId, companyId), eq(payments.projectId, projectId)))
    .orderBy(desc(payments.date));
  for (const r of pay)
    out.push({ kind: "PAYMENT", id: r.id, docNo: r.docNo ?? "", date: dateMs(r.date), total: BigInt(r.total), partyName: r.partyName });

  out.sort((a, b) => b.date - a.date);
  return out;
}

function dateMs(d: Date | number | null | undefined): number {
  if (d == null) return 0;
  return d instanceof Date ? d.getTime() : Number(d);
}
