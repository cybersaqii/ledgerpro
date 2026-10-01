// Module 9: Fixed Assets.
//
// Pure, unit-testable depreciation math (straight-line / declining-balance)
// plus the transactional asset operations: register → monthly depreciation
// runs (DRAFT → POSTED → VOIDED, one balanced journal per run) → sale /
// disposal (balanced journals with auto gain/loss) → inter-branch transfer
// (branch move only, no P&L).
//
// Asset PURCHASE is recorded through the normal purchase flow tagging the
// asset's cost account (14xx); the register itself never posts. The register
// tracks the sub-ledger (cost, salvage, method, life, accumulated
// depreciation) that depreciation runs charge to 6013 / 1400.
//
// Money is integer paisa / BigInt everywhere. Every query is scoped to
// company_id.

import { eq, and, desc, sql } from "drizzle-orm";
import { assets, depreciationRuns, depreciationEntries, bankAccounts, branches } from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

// ─── Pure depreciation math ──────────────────────────────────────────

export type DepMethod = "SL" | "DB";

/** Straight-line monthly depreciation (floor). The final month's catch-up
 *  (see monthlyDepreciationFor) absorbs any floor remainder. */
export function slMonthlyPaisa(costPaisa: bigint, salvagePaisa: bigint, usefulLifeYears: number): bigint {
  const months = Math.floor(usefulLifeYears) * 12;
  if (months <= 0) return 0n;
  const depreciable = costPaisa - salvagePaisa;
  if (depreciable <= 0n) return 0n;
  return depreciable / BigInt(months);
}

/** Declining-balance monthly depreciation (floor): nbv * rateBps / 120000. */
export function dbMonthlyPaisa(nbvPaisa: bigint, annualRateBps: number): bigint {
  if (nbvPaisa <= 0n || annualRateBps <= 0) return 0n;
  return (nbvPaisa * BigInt(Math.floor(annualRateBps))) / 120000n;
}

/** Full calendar months from the purchase month through the run month,
 *  inclusive. Negative when the run month precedes the purchase month. */
export function monthsElapsed(purchaseDate: Date, runYear: number, runMonth: number): number {
  const py = purchaseDate.getUTCFullYear();
  const pm = purchaseDate.getUTCMonth() + 1;
  return (runYear - py) * 12 + (runMonth - pm) + 1;
}

/** Net book value of an asset row: cost − accumulated depreciation. */
export function netBookValue(a: {
  purchaseCostPaisa: bigint | string | number;
  accumDepPaisa: bigint | string | number;
}): bigint {
  return BigInt(a.purchaseCostPaisa) - BigInt(a.accumDepPaisa);
}

export type AssetLike = {
  purchaseDate: Date;
  purchaseCostPaisa: bigint;
  salvageValuePaisa: bigint;
  depreciationMethod: string;
  usefulLifeYears: number;
  dbRateBps: number | null;
  accumDepPaisa: bigint;
  status: string;
};

/**
 * This month's depreciation for one asset in a run, or 0n when the asset is
 * not depreciable this month (not ACTIVE, run precedes purchase, nothing
 * left to depreciate). Guards:
 *  - never depreciate below salvage (amount ≤ cost − salvage − accumDep);
 *  - the last month of useful life absorbs the full remainder so SL floor
 *    rounding and DB asymptotics land exactly on salvage.
 */
export function depreciationForMonth(asset: AssetLike, runYear: number, runMonth: number): bigint {
  if (asset.status !== "ACTIVE") return 0n;
  const elapsed = monthsElapsed(asset.purchaseDate, runYear, runMonth);
  if (elapsed < 1) return 0n;
  const remaining = asset.purchaseCostPaisa - asset.salvageValuePaisa - asset.accumDepPaisa;
  if (remaining <= 0n) return 0n;

  const lifeMonths = Math.max(1, Math.floor(asset.usefulLifeYears) * 12);
  // Final month of useful life: take everything left so NBV lands on salvage.
  if (elapsed >= lifeMonths) return remaining;

  let amount: bigint;
  if (asset.depreciationMethod === "DB") {
    if (!asset.dbRateBps || asset.dbRateBps <= 0)
      throw new UserError("Declining-balance assets need an annual rate", 422, "DB_RATE_MISSING");
    const nbv = asset.purchaseCostPaisa - asset.accumDepPaisa;
    amount = dbMonthlyPaisa(nbv, asset.dbRateBps);
  } else {
    amount = slMonthlyPaisa(asset.purchaseCostPaisa, asset.salvageValuePaisa, asset.usefulLifeYears);
  }
  if (amount <= 0n) return 0n;
  // Net-book-value floor: never charge below salvage.
  return amount > remaining ? remaining : amount;
}

/** Projected schedule from the asset's current position (read-only preview).
 *  Returns up to `months` rows starting at (startYear, startMonth). */
export function projectSchedule(
  asset: AssetLike,
  startYear: number,
  startMonth: number,
  months = 12
): { year: number; month: number; depreciationPaisa: bigint; nbvAfterPaisa: bigint }[] {
  const rows: { year: number; month: number; depreciationPaisa: bigint; nbvAfterPaisa: bigint }[] = [];
  const sim: AssetLike = { ...asset };
  let y = startYear;
  let m = startMonth;
  for (let i = 0; i < months; i++) {
    const dep = depreciationForMonth(sim, y, m);
    if (dep <= 0n) break;
    sim.accumDepPaisa += dep;
    rows.push({
      year: y,
      month: m,
      depreciationPaisa: dep,
      nbvAfterPaisa: sim.purchaseCostPaisa - sim.accumDepPaisa,
    });
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return rows;
}

// ─── Asset register ──────────────────────────────────────────────────

export const ASSET_CLASSES = ["VEHICLE", "MACHINERY", "FURNITURE", "IT_EQUIPMENT", "BUILDING", "OTHER"] as const;

async function loadAssetForWrite(tx: DbTx, companyId: string, assetId: string) {
  const [a] = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)))
    .limit(1);
  if (!a) throw new UserError("Asset not found", 404, "ASSET_NOT_FOUND");
  return a;
}

/** Validate that an account belongs to the company and is an ASSET account. */
async function assertAssetAccount(tx: DbTx, companyId: string, accountId: string, field: string) {
  const ac = await accountMap(tx, companyId);
  const ids = new Set(Object.values(ac));
  if (!ids.has(accountId)) throw new UserError("Asset account not found", 422, `${field}_NOT_FOUND`);
}

export type CreateAssetInput = {
  companyId: string;
  code: string;
  description: string;
  serialNumber?: string;
  assetClass: string;
  accountId: string;
  accumDepAccountId?: string | null;
  branchId?: string | null;
  purchaseDate: Date;
  purchaseCostPaisa: bigint;
  salvageValuePaisa: bigint;
  depreciationMethod: DepMethod;
  usefulLifeYears: number;
  dbRateBps?: number | null;
  createdById: string;
};

export async function createAsset(tx: DbTx, args: CreateAssetInput): Promise<string> {
  const {
    companyId, code, description, assetClass, accountId, branchId,
    purchaseDate, purchaseCostPaisa, salvageValuePaisa,
    depreciationMethod, usefulLifeYears, createdById,
  } = args;
  const cleanCode = code.trim().toUpperCase();
  if (!cleanCode) throw new UserError("Asset code is required", 422, "ASSET_CODE_REQUIRED");
  if (!description.trim()) throw new UserError("Asset description is required", 422, "ASSET_DESCRIPTION_REQUIRED");
  if (!ASSET_CLASSES.includes(assetClass as (typeof ASSET_CLASSES)[number]))
    throw new UserError("Unknown asset class", 422, "ASSET_CLASS_INVALID");
  if (purchaseCostPaisa <= 0n) throw new UserError("Purchase cost must be positive", 422, "ASSET_COST_INVALID");
  if (salvageValuePaisa < 0n) throw new UserError("Salvage value cannot be negative", 422, "ASSET_SALVAGE_INVALID");
  if (salvageValuePaisa >= purchaseCostPaisa)
    throw new UserError("Salvage value must be below purchase cost", 422, "ASSET_SALVAGE_INVALID");
  if (!Number.isInteger(usefulLifeYears) || usefulLifeYears < 1 || usefulLifeYears > 100)
    throw new UserError("Useful life must be 1–100 years", 422, "ASSET_LIFE_INVALID");
  if (depreciationMethod !== "SL" && depreciationMethod !== "DB")
    throw new UserError("Depreciation method must be SL or DB", 422, "ASSET_METHOD_INVALID");
  const dbRateBps = depreciationMethod === "DB" ? args.dbRateBps ?? null : null;
  if (depreciationMethod === "DB" && (!dbRateBps || dbRateBps <= 0 || dbRateBps > 10000))
    throw new UserError("DB assets need an annual rate between 0% and 100%", 422, "DB_RATE_INVALID");

  await assertAssetAccount(tx, companyId, accountId, "ASSET_ACCOUNT");
  if (args.accumDepAccountId) await assertAssetAccount(tx, companyId, args.accumDepAccountId, "ACCUM_DEP_ACCOUNT");

  const [dup] = await tx
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.companyId, companyId), eq(assets.code, cleanCode)))
    .limit(1);
  if (dup) throw new UserError(`Asset code ${cleanCode} already exists`, 422, "ASSET_CODE_DUPLICATE");

  const id = crypto.randomUUID();
  await tx.insert(assets).values({
    id,
    companyId,
    code: cleanCode,
    description: description.trim(),
    serialNumber: args.serialNumber?.trim() || null,
    assetClass,
    accountId,
    accumDepAccountId: args.accumDepAccountId ?? null,
    branchId: branchId ?? null,
    purchaseDate,
    purchaseCostPaisa,
    salvageValuePaisa,
    depreciationMethod,
    usefulLifeYears,
    dbRateBps,
    createdById,
  });
  return id;
}

export type UpdateAssetInput = {
  description?: string;
  serialNumber?: string | null;
  assetClass?: string;
  branchId?: string | null;
  salvageValuePaisa?: bigint;
  usefulLifeYears?: number;
  dbRateBps?: number | null;
  accumDepAccountId?: string | null;
};

/** Edit register fields of an asset that has no posted depreciation yet.
 *  Posted assets keep their policy locked so the sub-ledger stays auditable. */
export async function updateAsset(
  tx: DbTx,
  args: { companyId: string; assetId: string } & UpdateAssetInput
): Promise<void> {
  const a = await loadAssetForWrite(tx, args.companyId, args.assetId);
  if (BigInt(a.accumDepPaisa) > 0n)
    throw new UserError("Policy is locked once depreciation is posted", 422, "ASSET_POLICY_LOCKED");
  const patch: Record<string, unknown> = {};
  if (args.description !== undefined) {
    if (!args.description.trim()) throw new UserError("Asset description is required", 422, "ASSET_DESCRIPTION_REQUIRED");
    patch.description = args.description.trim();
  }
  if (args.serialNumber !== undefined) patch.serialNumber = args.serialNumber?.trim() || null;
  if (args.assetClass !== undefined) {
    if (!ASSET_CLASSES.includes(args.assetClass as (typeof ASSET_CLASSES)[number]))
      throw new UserError("Unknown asset class", 422, "ASSET_CLASS_INVALID");
    patch.assetClass = args.assetClass;
  }
  if (args.branchId !== undefined) patch.branchId = args.branchId;
  if (args.salvageValuePaisa !== undefined) {
    const cost = BigInt(a.purchaseCostPaisa);
    if (args.salvageValuePaisa < 0n || args.salvageValuePaisa >= cost)
      throw new UserError("Salvage value must be below purchase cost", 422, "ASSET_SALVAGE_INVALID");
    patch.salvageValuePaisa = args.salvageValuePaisa;
  }
  if (args.usefulLifeYears !== undefined) {
    if (!Number.isInteger(args.usefulLifeYears) || args.usefulLifeYears < 1 || args.usefulLifeYears > 100)
      throw new UserError("Useful life must be 1–100 years", 422, "ASSET_LIFE_INVALID");
    patch.usefulLifeYears = args.usefulLifeYears;
  }
  if (args.dbRateBps !== undefined) {
    if (a.depreciationMethod !== "DB") throw new UserError("Rate applies to DB assets only", 422, "DB_RATE_INVALID");
    if (!args.dbRateBps || args.dbRateBps <= 0 || args.dbRateBps > 10000)
      throw new UserError("DB assets need an annual rate between 0% and 100%", 422, "DB_RATE_INVALID");
    patch.dbRateBps = args.dbRateBps;
  }
  if (args.accumDepAccountId !== undefined) {
    if (args.accumDepAccountId) await assertAssetAccount(tx, args.companyId, args.accumDepAccountId, "ACCUM_DEP_ACCOUNT");
    patch.accumDepAccountId = args.accumDepAccountId;
  }
  if (Object.keys(patch).length === 0) return;
  await tx.update(assets).set(patch).where(eq(assets.id, a.id));
}

/** Delete an asset only when it has never been depreciated, sold or disposed. */
export async function deleteAsset(tx: DbTx, args: { companyId: string; assetId: string }): Promise<void> {
  const a = await loadAssetForWrite(tx, args.companyId, args.assetId);
  if (BigInt(a.accumDepPaisa) > 0n || a.status !== "ACTIVE" || a.disposalJournalEntryId)
    throw new UserError("Only untouched assets can be deleted", 422, "ASSET_DELETE_BLOCKED");
  const [entry] = await tx
    .select({ id: depreciationEntries.id })
    .from(depreciationEntries)
    .where(and(eq(depreciationEntries.assetId, a.id), eq(depreciationEntries.companyId, args.companyId)))
    .limit(1);
  if (entry) throw new UserError("Asset has depreciation history — dispose or sell it instead", 422, "ASSET_DELETE_BLOCKED");
  await tx.delete(assets).where(eq(assets.id, a.id));
}

// ─── Depreciation runs ───────────────────────────────────────────────

function runDateFor(year: number, month: number): Date {
  // Last instant of the run month (UTC).
  return new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
}

async function loadRunForWrite(tx: DbTx, companyId: string, runId: string) {
  const [r] = await tx
    .select()
    .from(depreciationRuns)
    .where(and(eq(depreciationRuns.id, runId), eq(depreciationRuns.companyId, companyId)))
    .limit(1);
  if (!r) throw new UserError("Depreciation run not found", 404, "DEP_RUN_NOT_FOUND");
  return r;
}

/**
 * Create a DRAFT run for (year, month), snapshotting one entry per
 * depreciable ACTIVE asset. Idempotent per (company, year, month): an
 * explicit guard plus the UNIQUE index backstop a double "Run" click.
 */
export async function createDepreciationRun(
  tx: DbTx,
  args: { companyId: string; year: number; month: number; createdById: string }
): Promise<string> {
  const { companyId, year, month, createdById } = args;
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new UserError("Invalid year", 422, "INVALID_PERIOD");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new UserError("Invalid month", 422, "INVALID_PERIOD");

  const runDate = runDateFor(year, month);
  await assertPeriodOpen(tx, companyId, runDate);
  const mm = String(month).padStart(2, "0");

  // Explicit guard first (the UNIQUE index is the backstop for races).
  const [dup] = await tx
    .select({ id: depreciationRuns.id })
    .from(depreciationRuns)
    .where(and(eq(depreciationRuns.companyId, companyId), eq(depreciationRuns.year, year), eq(depreciationRuns.month, month)))
    .limit(1);
  if (dup) throw new UserError(`A depreciation run already exists for ${year}-${mm}`, 422, "DEP_RUN_ALREADY_EXISTS");

  const actives = await tx
    .select()
    .from(assets)
    .where(and(eq(assets.companyId, companyId), eq(assets.status, "ACTIVE")));

  const runId = crypto.randomUUID();
  const entryValues: {
    id: string; companyId: string; runId: string; assetId: string;
    assetCode: string; assetDescription: string; depreciationPaisa: bigint;
    nbvBeforePaisa: bigint; nbvAfterPaisa: bigint;
  }[] = [];
  let total = 0n;
  for (const a of actives) {
    const like: AssetLike = {
      purchaseDate: a.purchaseDate,
      purchaseCostPaisa: BigInt(a.purchaseCostPaisa),
      salvageValuePaisa: BigInt(a.salvageValuePaisa),
      depreciationMethod: a.depreciationMethod,
      usefulLifeYears: a.usefulLifeYears,
      dbRateBps: a.dbRateBps,
      accumDepPaisa: BigInt(a.accumDepPaisa),
      status: a.status,
    };
    const amount = depreciationForMonth(like, year, month);
    if (amount <= 0n) continue;
    const nbvBefore = like.purchaseCostPaisa - like.accumDepPaisa;
    entryValues.push({
      id: crypto.randomUUID(),
      companyId,
      runId,
      assetId: a.id,
      assetCode: a.code,
      assetDescription: a.description,
      depreciationPaisa: amount,
      nbvBeforePaisa: nbvBefore,
      nbvAfterPaisa: nbvBefore - amount,
    });
    total += amount;
  }

  if (entryValues.length === 0)
    throw new UserError("No assets are due depreciation for this month", 422, "DEP_RUN_EMPTY");

  try {
    await tx.insert(depreciationRuns).values({
      id: runId,
      companyId,
      year,
      month,
      status: "DRAFT",
      docNo: await nextDocNo(tx, companyId, "DEPRECIATION_RUN", `DEP-${year}${mm}-`),
      runDate,
      totalDepreciationPaisa: total,
      createdById,
    });
  } catch (e) {
    if (/unique/i.test(String(e)))
      throw new UserError(`A depreciation run already exists for ${year}-${mm}`, 422, "DEP_RUN_ALREADY_EXISTS");
    throw e;
  }
  await tx.insert(depreciationEntries).values(entryValues);
  return runId;
}

/**
 * "Post Depreciation": DRAFT → POSTED with ONE balanced journal:
 *   Dr 6013 Depreciation Expense (per asset)
 *   Cr 1400 Accumulated Depreciation (per asset, or the asset's own
 *      accum-dep account when overridden)
 * Asset sub-ledgers are charged; assets landing on salvage become DEPRECIATED.
 */
export async function postDepreciationRun(
  tx: DbTx,
  args: { companyId: string; runId: string; createdById: string }
): Promise<{ journalEntryId: string }> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "DRAFT") throw new UserError(`Run is ${run.status} — only drafts can be posted`, 422, "DEP_RUN_NOT_DRAFT");

  await assertPeriodOpen(tx, args.companyId, run.runDate);

  const entries = await tx
    .select()
    .from(depreciationEntries)
    .where(and(eq(depreciationEntries.companyId, args.companyId), eq(depreciationEntries.runId, args.runId)));

  // An asset sold/disposed between DRAFT and posting must not be charged.
  const live: typeof entries = [];
  for (const e of entries) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    if (a.status === "ACTIVE") live.push(e);
  }
  if (live.length === 0) throw new UserError("No active assets left to post", 422, "DEP_RUN_EMPTY");

  const ac = await accountMap(tx, args.companyId);
  const period = `${run.year}-${String(run.month).padStart(2, "0")}`;

  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [];
  for (const e of live) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    const amount = BigInt(e.depreciationPaisa);
    const accumAcct = a.accumDepAccountId ?? ac[SYS.ACCUM_DEPRECIATION];
    lines.push({
      accountId: ac[SYS.DEPRECIATION_EXPENSE],
      debit: amount,
      credit: 0n,
      memo: `Depreciation ${period} — ${e.assetCode} ${e.assetDescription}`,
    });
    lines.push({ accountId: accumAcct, debit: 0n, credit: amount, memo: `${e.assetCode} ${e.assetDescription}` });
  }

  const journalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date: run.runDate,
    memo: `Depreciation ${period} — ${live.length} asset(s)`,
    reference: run.docNo ?? undefined,
    source: "DEPRECIATION",
    sourceId: args.runId,
    idempotencyKey: `dep-run:${args.runId}`,
    createdById: args.createdById,
    lines,
  });

  // Charge the asset sub-ledgers; mark fully-depreciated assets DEPRECIATED.
  for (const e of live) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    const newAccum = BigInt(a.accumDepPaisa) + BigInt(e.depreciationPaisa);
    const nbv = BigInt(a.purchaseCostPaisa) - newAccum;
    await tx
      .update(assets)
      .set({
        accumDepPaisa: newAccum,
        status: nbv <= BigInt(a.salvageValuePaisa) ? "DEPRECIATED" : "ACTIVE",
      })
      .where(eq(assets.id, a.id));
  }

  // Drop entries for assets that left the run (sold/disposed while DRAFT).
  const dropped = entries.filter((e) => !live.some((l) => l.id === e.id));
  for (const e of dropped) {
    await tx.delete(depreciationEntries).where(eq(depreciationEntries.id, e.id));
  }
  const postedTotal = live.reduce((s, e) => s + BigInt(e.depreciationPaisa), 0n);
  await tx
    .update(depreciationRuns)
    .set({ status: "POSTED", journalEntryId, postedAt: new Date(), totalDepreciationPaisa: postedTotal })
    .where(eq(depreciationRuns.id, args.runId));
  return { journalEntryId };
}

/** Void a POSTED run via a reversing journal; asset sub-ledgers are restored
 *  (DEPRECIATED assets charged by this run return to ACTIVE). A run whose
 *  assets were since sold/disposed cannot be voided. */
export async function voidDepreciationRun(
  tx: DbTx,
  args: { companyId: string; runId: string; createdById: string }
): Promise<{ reversingJournalEntryId: string }> {
  const run = await loadRunForWrite(tx, args.companyId, args.runId);
  if (run.status !== "POSTED") throw new UserError(`Only posted runs can be voided (status: ${run.status})`, 422, "DEP_RUN_NOT_POSTED");

  const entries = await tx
    .select()
    .from(depreciationEntries)
    .where(and(eq(depreciationEntries.companyId, args.companyId), eq(depreciationEntries.runId, args.runId)));
  if (entries.length === 0) throw new UserError("Run has no entries", 422, "DEP_RUN_EMPTY");

  // Assets charged by this run must still be held; otherwise the sub-ledger
  // no longer matches what the reversal would restore.
  for (const e of entries) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    if (a.status === "SOLD" || a.status === "DISPOSED")
      throw new UserError(
        `Asset ${a.code} was ${a.status.toLowerCase()} after this run — the run cannot be voided`,
        422,
        "DEP_VOID_ASSET_MOVED"
      );
  }

  const ac = await accountMap(tx, args.companyId);
  const period = `${run.year}-${String(run.month).padStart(2, "0")}`;

  // Mirror image of the posting journal.
  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [];
  for (const e of entries) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    const amount = BigInt(e.depreciationPaisa);
    const accumAcct = a.accumDepAccountId ?? ac[SYS.ACCUM_DEPRECIATION];
    lines.push({
      accountId: ac[SYS.DEPRECIATION_EXPENSE],
      debit: 0n,
      credit: amount,
      memo: `Void depreciation ${period} — ${e.assetCode}`,
    });
    lines.push({ accountId: accumAcct, debit: amount, credit: 0n, memo: `${e.assetCode}` });
  }

  const reversingJournalEntryId = await createJournal(tx, {
    companyId: args.companyId,
    date: new Date(),
    memo: `Void depreciation ${period} (${run.docNo})`,
    reference: run.journalEntryId ?? undefined,
    source: "DEPRECIATION_VOID",
    sourceId: args.runId,
    idempotencyKey: `dep-void:${args.runId}`,
    createdById: args.createdById,
    lines,
  });

  for (const e of entries) {
    const a = await loadAssetForWrite(tx, args.companyId, e.assetId);
    const restored = BigInt(a.accumDepPaisa) - BigInt(e.depreciationPaisa);
    await tx
      .update(assets)
      .set({
        accumDepPaisa: restored < 0n ? 0n : restored,
        // Only this run could have made it DEPRECIATED (entries require ACTIVE).
        status: a.status === "DEPRECIATED" ? "ACTIVE" : a.status,
      })
      .where(eq(assets.id, a.id));
  }

  await tx
    .update(depreciationRuns)
    .set({ status: "VOIDED", voidedAt: new Date() })
    .where(eq(depreciationRuns.id, args.runId));
  return { reversingJournalEntryId };
}

// ─── Asset movements ─────────────────────────────────────────────────

/**
 * Sell an asset for `salePricePaisa` received into a bank/cash account.
 * Balanced journal:
 *   Dr bank/cash                       sale price
 *   Dr Accumulated Depreciation        accum dep
 *   Dr 6030 Loss on Disposal           (nbv − price, when loss)
 *     Cr asset cost account            cost
 *     Cr 4110 Gain on Disposal         (price − nbv, when gain)
 */
export async function sellAsset(
  tx: DbTx,
  args: {
    companyId: string;
    assetId: string;
    salePricePaisa: bigint;
    date: Date;
    bankAccountId: string;
    createdById: string;
  }
): Promise<{ journalEntryId: string; gainLossPaisa: bigint }> {
  const { companyId, assetId, salePricePaisa, date, bankAccountId, createdById } = args;
  if (salePricePaisa <= 0n) throw new UserError("Sale price must be positive", 422, "ASSET_SALE_PRICE_INVALID");

  const a = await loadAssetForWrite(tx, companyId, assetId);
  if (a.status !== "ACTIVE" && a.status !== "DEPRECIATED")
    throw new UserError(`Only held assets can be sold (status: ${a.status})`, 422, "ASSET_SALE_INVALID_STATUS");

  const [bank] = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, bankAccountId), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  if (!bank) throw new UserError("Bank/cash account not found", 422, "BANK_NOT_FOUND");

  await assertPeriodOpen(tx, companyId, date);

  const ac = await accountMap(tx, companyId);
  const cost = BigInt(a.purchaseCostPaisa);
  const accumDep = BigInt(a.accumDepPaisa);
  const nbv = cost - accumDep;
  const gainLoss = salePricePaisa - nbv; // +gain / −loss
  const accumAcct = a.accumDepAccountId ?? ac[SYS.ACCUM_DEPRECIATION];

  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [
    { accountId: bank.accountId, debit: salePricePaisa, credit: 0n, memo: `Sale of ${a.code} — ${bank.name}` },
    { accountId: accumAcct, debit: accumDep, credit: 0n, memo: `${a.code} accum. depreciation` },
  ];
  if (gainLoss > 0n)
    lines.push({ accountId: ac[SYS.GAIN_ON_DISPOSAL], debit: 0n, credit: gainLoss, memo: `Gain on sale of ${a.code}` });
  else if (gainLoss < 0n)
    lines.push({ accountId: ac[SYS.LOSS_ON_DISPOSAL], debit: -gainLoss, credit: 0n, memo: `Loss on sale of ${a.code}` });
  lines.push({ accountId: a.accountId, debit: 0n, credit: cost, memo: `${a.code} ${a.description}` });

  const journalEntryId = await createJournal(tx, {
    companyId,
    date,
    memo: `Sale of fixed asset ${a.code} — ${a.description}`,
    reference: a.code,
    source: "ASSET_SALE",
    sourceId: a.id,
    idempotencyKey: `asset-sell:${a.id}`,
    createdById,
    lines,
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${salePricePaisa}` })
    .where(eq(bankAccounts.id, bank.id));
  await tx
    .update(assets)
    .set({
      status: "SOLD",
      soldAt: date,
      salePricePaisa,
      gainLossPaisa: gainLoss,
      disposalJournalEntryId: journalEntryId,
    })
    .where(eq(assets.id, a.id));
  return { journalEntryId, gainLossPaisa: gainLoss };
}

/**
 * Scrap / dispose an asset with no proceeds:
 *   Dr Accumulated Depreciation   accum dep
 *   Dr 6030 Loss on Disposal       nbv
 *     Cr asset cost account        cost
 */
export async function disposeAsset(
  tx: DbTx,
  args: { companyId: string; assetId: string; date: Date; createdById: string }
): Promise<{ journalEntryId: string }> {
  const { companyId, assetId, date, createdById } = args;
  const a = await loadAssetForWrite(tx, companyId, assetId);
  if (a.status !== "ACTIVE" && a.status !== "DEPRECIATED")
    throw new UserError(`Only held assets can be disposed (status: ${a.status})`, 422, "ASSET_DISPOSE_INVALID_STATUS");

  await assertPeriodOpen(tx, companyId, date);

  const ac = await accountMap(tx, companyId);
  const cost = BigInt(a.purchaseCostPaisa);
  const accumDep = BigInt(a.accumDepPaisa);
  const nbv = cost - accumDep;
  const accumAcct = a.accumDepAccountId ?? ac[SYS.ACCUM_DEPRECIATION];

  const lines: { accountId: string; debit: bigint; credit: bigint; memo?: string }[] = [
    { accountId: accumAcct, debit: accumDep, credit: 0n, memo: `${a.code} accum. depreciation` },
    { accountId: ac[SYS.LOSS_ON_DISPOSAL], debit: nbv, credit: 0n, memo: `Scrapping of ${a.code}` },
    { accountId: a.accountId, debit: 0n, credit: cost, memo: `${a.code} ${a.description}` },
  ];

  const journalEntryId = await createJournal(tx, {
    companyId,
    date,
    memo: `Disposal (scrapping) of fixed asset ${a.code} — ${a.description}`,
    reference: a.code,
    source: "ASSET_DISPOSE",
    sourceId: a.id,
    idempotencyKey: `asset-dispose:${a.id}`,
    createdById,
    lines,
  });

  await tx
    .update(assets)
    .set({
      status: "DISPOSED",
      soldAt: date,
      salePricePaisa: 0n,
      gainLossPaisa: -nbv,
      disposalJournalEntryId: journalEntryId,
    })
    .where(eq(assets.id, a.id));
  return { journalEntryId };
}

/** Move an asset between branches. Branch move only — no P&L, no journal. */
export async function transferAsset(
  tx: DbTx,
  args: { companyId: string; assetId: string; toBranchId: string; createdById: string }
): Promise<void> {
  const a = await loadAssetForWrite(tx, args.companyId, args.assetId);
  if (a.status === "SOLD" || a.status === "DISPOSED")
    throw new UserError("Sold/disposed assets cannot be transferred", 422, "ASSET_TRANSFER_INVALID_STATUS");
  if (a.branchId === args.toBranchId) throw new UserError("Asset is already at that branch", 422, "ASSET_TRANSFER_SAME");
  const [b] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, args.toBranchId), eq(branches.companyId, args.companyId)))
    .limit(1);
  if (!b) throw new UserError("Branch not found", 422, "BRANCH_NOT_FOUND");
  await tx.update(assets).set({ branchId: b.id }).where(eq(assets.id, a.id));
}

/** Read helper: asset with its GL account ids resolved (for UI detail). */
export async function getAsset(db: Db, companyId: string, assetId: string) {
  const [a] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, assetId), eq(assets.companyId, companyId)))
    .limit(1);
  return a ?? null;
}

export async function listRuns(db: Db, companyId: string) {
  return db
    .select()
    .from(depreciationRuns)
    .where(eq(depreciationRuns.companyId, companyId))
    .orderBy(desc(depreciationRuns.year), desc(depreciationRuns.month))
    .limit(120);
}

export async function getRunWithEntries(db: Db, companyId: string, runId: string) {
  const [run] = await db
    .select()
    .from(depreciationRuns)
    .where(and(eq(depreciationRuns.id, runId), eq(depreciationRuns.companyId, companyId)))
    .limit(1);
  if (!run) return null;
  const entries = await db
    .select()
    .from(depreciationEntries)
    .where(and(eq(depreciationEntries.runId, runId), eq(depreciationEntries.companyId, companyId)));
  return { run, entries };
}
