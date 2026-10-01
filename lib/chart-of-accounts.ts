import { eq, and } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { UserError } from "./errors";
import type { DbTx } from "./db";

/**
 * Chart-of-accounts code ranges (Module 5.1).
 *
 * The spec writes the ranges in 5 digits (10000–19999 ASSETS, 20000–29999
 * LIABILITIES, 30000–39999 EQUITY, 40000–49999 REVENUE, 50000–59999 EXPENSES).
 * This codebase has always used 4-digit codes (1001, 1100, 2001, 3001, 4001,
 * 5001, 6000, …) via SYS in lib/setup.ts, and existing companies already
 * carry years of postings on those codes — renumbering is off the table.
 * The mapping below pins the spec's ranges onto the existing scheme:
 *
 *   spec 10000–19999 ASSETS      → codes 1000–1999 (type ASSET)
 *   spec 20000–29999 LIABILITIES → codes 2000–2999 (type LIABILITY)
 *   spec 30000–39999 EQUITY      → codes 3000–3999 (type EQUITY)
 *   spec 40000–49999 REVENUE     → codes 4000–4999 (type INCOME — the
 *                                   codebase's name for revenue accounts)
 *   spec 50000–59999 EXPENSES    → codes 5000–6999 (type EXPENSE — extended to
 *                                   6xxx because 6000 "General Expenses" and
 *                                   its family live in the 6000 block)
 *
 * `validateAccountCode` enforces this on every account create/update so a
 * revenue account can never be filed under an asset code range.
 */
export const ACCOUNT_CODE_RANGES = [
  { type: "ASSET", min: 1000, max: 1999, spec: "10000–19999" },
  { type: "LIABILITY", min: 2000, max: 2999, spec: "20000–29999" },
  { type: "EQUITY", min: 3000, max: 3999, spec: "30000–39999" },
  { type: "INCOME", min: 4000, max: 4999, spec: "40000–49999" },
  { type: "EXPENSE", min: 5000, max: 6999, spec: "50000–59999" },
] as const;

export type AccountType = (typeof ACCOUNT_CODE_RANGES)[number]["type"];

/** The 4-digit range an account type must live in. */
export function rangeForType(type: string): { min: number; max: number; spec: string } {
  const r = ACCOUNT_CODE_RANGES.find((x) => x.type === type);
  if (!r) throw new UserError(`Unknown account type "${type}".`, 422, "INVALID_ACCOUNT_TYPE");
  return r;
}

/** Infer the account type from a 4-digit code, or null when outside every range. */
export function typeForCode(code: string): AccountType | null {
  const n = /^\d{4,5}$/.test(code.trim()) ? parseInt(code.trim(), 10) : NaN;
  if (isNaN(n)) return null;
  const r = ACCOUNT_CODE_RANGES.find((x) => n >= x.min && n <= x.max);
  return r ? r.type : null;
}

/**
 * Validate a code against its type's range. Throws UserError (stable codes)
 * when the code is not numeric or falls outside the type's range.
 */
export function validateAccountCode(code: string, type: string): void {
  const t = code.trim();
  const inferred = typeForCode(t);
  if (inferred === null) {
    const r = rangeForType(type);
    throw new UserError(
      `Account code "${code}" is not a valid 4-digit code. ${type} accounts must use codes ${r.min}–${r.max}.`,
      422,
      "ACCOUNT_CODE_OUT_OF_RANGE"
    );
  }
  if (inferred !== type) {
    const r = rangeForType(type);
    throw new UserError(
      `Code ${t} belongs to the ${inferred} range. ${type} accounts must use codes ${r.min}–${r.max} (spec ${r.spec}).`,
      422,
      "ACCOUNT_CODE_TYPE_MISMATCH"
    );
  }
}

export type AccountRow = {
  id: string;
  code: string;
  name: string;
  type: string;
  parentId: string | null;
  isSystem: boolean;
  isActive: boolean;
  openingBalance: bigint;
};

export type AccountNode = AccountRow & { children: AccountNode[] };

/**
 * Build the parent → child tree used by the chart-of-accounts page.
 * Orphans (parentId pointing at a missing account) are attached at root so
 * nothing ever disappears from the listing.
 */
export function buildAccountTree(rows: AccountRow[]): AccountNode[] {
  const byId = new Map<string, AccountNode>();
  for (const r of rows) byId.set(r.id, { ...r, children: [] });
  const roots: AccountNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const byCode = (a: AccountNode, b: AccountNode) => a.code.localeCompare(b.code);
  for (const node of byId.values()) node.children.sort(byCode);
  roots.sort(byCode);
  return roots;
}

/**
 * True when assigning `parentId` as the parent of `accountId` would create a
 * cycle (parent is the account itself or one of its descendants).
 */
export function wouldCycle(rows: Pick<AccountRow, "id" | "parentId">[], accountId: string, parentId: string | null): boolean {
  if (!parentId) return false;
  if (parentId === accountId) return true;
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  let cur: string | null | undefined = parentId;
  const seen = new Set<string>();
  while (cur) {
    if (cur === accountId) return true;
    if (seen.has(cur)) return true; // pre-existing cycle: refuse rather than loop
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

/** Load every account of a company (for tree building / parent pickers). */
export async function listCompanyAccounts(tx: DbTx, companyId: string): Promise<AccountRow[]> {
  const rows = await tx
    .select({
      id: accounts.id,
      code: accounts.code,
      name: accounts.name,
      type: accounts.type,
      parentId: accounts.parentId,
      isSystem: accounts.isSystem,
      isActive: accounts.isActive,
      openingBalance: accounts.openingBalance,
    })
    .from(accounts)
    .where(eq(accounts.companyId, companyId));
  return rows.map((r) => ({ ...r, openingBalance: BigInt(r.openingBalance) }));
}

/** How many journal lines reference this account — used to block deletion. */
export async function countAccountUsage(tx: DbTx, accountId: string): Promise<number> {
  const { journalLines } = await import("@/db/schema");
  const rows = await tx
    .select({ id: journalLines.id })
    .from(journalLines)
    .where(eq(journalLines.accountId, accountId))
    .limit(1);
  return rows.length;
}

/** Fetch one company account or throw 404. */
export async function getCompanyAccount(tx: DbTx, companyId: string, accountId: string) {
  const rows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw new UserError("Account not found.", 404, "ACCOUNT_NOT_FOUND");
  return rows[0];
}
