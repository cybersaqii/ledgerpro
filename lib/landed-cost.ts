// Module 19 — Import / landed-cost allocation.
//
// A landed-cost sheet allocates freight / duty / clearing / other charges
// over the goods of a purchase bill (or GRN), on a chosen basis:
//   VALUE  — proportional to each line's net value (paisa)
//   QTY    — proportional to each line's received quantity (base milli-units)
//   WEIGHT — proportional to qty × product weight (grams, integer)
//
// Allocation is exact: shares sum to the total paisa via the largest-
// remainder method (any rounding remainder goes to the largest line).
//
// Posting (balanced, journal-per-sheet):
//   Dr Inventory (grouped by each product's inventory account, dust to 1200)
//   Cr Landed Cost Clearing (2124 — settled later by a normal payment)
// and each product's moving-average cost is bumped via adjustStockCost.
// Void = exact reversing journal + negative cost adjustments.

import { and, eq, inArray } from "drizzle-orm";
import {
  landedCostSheets,
  landedCostHeads,
  landedCostLines,
  products,
  purchaseDocs,
  purchaseDocItems,
  stockLevels,
} from "@/db/schema";
import type { DbTx } from "./db";
import { UserError } from "./errors";
import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal, adjustStockCost, type JournalLineInput } from "./posting";
import { productAccounts } from "./stock-ledger";

export type LandedBasis = "VALUE" | "QTY" | "WEIGHT";
export type LandedHead = "FREIGHT" | "DUTY" | "CLEARING" | "OTHER";

export const LANDED_BASES: LandedBasis[] = ["VALUE", "QTY", "WEIGHT"];
export const LANDED_HEADS: LandedHead[] = ["FREIGHT", "DUTY", "CLEARING", "OTHER"];

/**
 * Pure allocation engine. Distributes `totalPaisa` over `basisValues` in
 * proportion to each value, largest-remainder: floor shares first, then the
 * leftover paisa go one-by-one to the lines with the largest fractional
 * remainders (ties → earliest line). The result always sums to exactly
 * `totalPaisa`. Throws when every basis value is zero/negative.
 */
export function allocateLandedCost(totalPaisa: bigint, basisValues: bigint[]): bigint[] {
  if (totalPaisa <= 0n) throw new UserError("Landed cost total must be positive.", 422, "LCS_BAD_TOTAL");
  if (basisValues.length === 0) throw new UserError("A sheet needs at least one line.", 422, "LCS_NO_LINES");
  const total = basisValues.reduce((a, v) => a + (v > 0n ? v : 0n), 0n);
  if (total <= 0n)
    throw new UserError("Cannot allocate: every line's basis value is zero.", 422, "LCS_ZERO_BASIS");

  // floor_i = total × v_i / W ; rem_i = total × v_i % W  (all BigInt, exact)
  const floors: bigint[] = [];
  const fracs: { idx: number; frac: bigint }[] = [];
  let floored = 0n;
  for (let i = 0; i < basisValues.length; i++) {
    const v = basisValues[i]! > 0n ? basisValues[i]! : 0n;
    const p = totalPaisa * v;
    const f = p / total;
    floors.push(f);
    fracs.push({ idx: i, frac: p % total });
    floored += f;
  }
  let leftover = totalPaisa - floored;
  // Largest remainder first; stable on ties (earliest line wins).
  fracs.sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.idx - b.idx));
  const out = [...floors];
  for (const { idx } of fracs) {
    if (leftover <= 0n) break;
    out[idx]! += 1n;
    leftover -= 1n;
  }
  return out;
}

export type SheetHeadInput = { head: LandedHead; label?: string; amountPaisa: bigint };
export type SheetLineInput = { productId: string };

export type PostSheetInput = {
  companyId: string;
  branchId: string;
  date: Date;
  purchaseDocId?: string | null;
  basis: LandedBasis;
  heads: SheetHeadInput[];
  /** Explicit lines (used when no purchase doc is linked). */
  lines: SheetLineInput[];
  createdById: string;
  idempotencyKey?: string;
};

type ResolvedLine = {
  productId: string;
  qtyMilli: bigint;
  valuePaisa: bigint;
  weightScaled: bigint; // qtyMilli × weightGrams
};

async function resolveLines(
  tx: DbTx,
  companyId: string,
  branchId: string,
  input: PostSheetInput
): Promise<ResolvedLine[]> {
  if (!LANDED_BASES.includes(input.basis))
    throw new UserError("Unknown allocation basis.", 422, "LCS_BAD_BASIS");

  // Linked purchase doc: derive the basis values from its lines.
  if (input.purchaseDocId) {
    const docs = await tx
      .select()
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, input.purchaseDocId), eq(purchaseDocs.companyId, companyId)))
      .limit(1);
    const doc = docs[0];
    if (!doc) throw new UserError("Purchase document not found.", 404, "LCS_NO_DOC");
    if (doc.docType !== "BILL" && doc.docType !== "GRN")
      throw new UserError("A sheet can only link a purchase bill or GRN.", 422, "LCS_BAD_DOC");
    const items = await tx
      .select()
      .from(purchaseDocItems)
      .where(eq(purchaseDocItems.docId, doc.id));
    const stockItems = items.filter((i) => i.productId);
    if (stockItems.length === 0) throw new UserError("The linked document has no product lines.", 422, "LCS_NO_LINES");

    const prodRows = await tx
      .select({ id: products.id, weightGrams: products.weightGrams })
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          inArray(products.id, [...new Set(stockItems.map((i) => i.productId!))])
        )
      );
    const prodMap = new Map(prodRows.map((p) => [p.id, p]));

    // Merge duplicate products (a bill may list the same product twice).
    const merged = new Map<string, ResolvedLine>();
    for (const i of stockItems) {
      const pid = i.productId!;
      const p = prodMap.get(pid);
      if (!p) throw new UserError("A product on the linked document no longer exists.", 422, "LCS_NO_PRODUCT");
      // GRN lines: the accepted (received) quantity is what hit stock.
      const qtyMilli = doc.docType === "GRN" ? i.qtyReceived : i.qty;
      const valuePaisa = i.lineTotal - i.taxAmount; // net of tax
      const weightScaled = qtyMilli * BigInt(p.weightGrams);
      const cur = merged.get(pid);
      if (cur) {
        cur.qtyMilli += qtyMilli;
        cur.valuePaisa += valuePaisa;
        cur.weightScaled += weightScaled;
      } else {
        merged.set(pid, { productId: pid, qtyMilli, valuePaisa, weightScaled });
      }
    }
    return [...merged.values()];
  }

  // Explicit lines (no linked doc): measure the basis against live stock at
  // the branch — qty on hand, stock value at moving average, weight.
  if (input.lines.length === 0) throw new UserError("A sheet needs at least one line.", 422, "LCS_NO_LINES");
  const ids = [...new Set(input.lines.map((l) => l.productId))];
  const prodRows = await tx
    .select({ id: products.id, weightGrams: products.weightGrams })
    .from(products)
    .where(and(eq(products.companyId, companyId), inArray(products.id, ids)));
  if (prodRows.length !== ids.length)
    throw new UserError("One of the selected products is invalid.", 422, "LCS_NO_PRODUCT");
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  const out: ResolvedLine[] = [];
  for (const pid of ids) {
    const p = prodMap.get(pid)!;
    const [level] = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, pid), eq(stockLevels.branchId, branchId)))
      .limit(1);
    const qtyMilli = level?.qty ?? 0n;
    const avg = level?.avgCost ?? 0n;
    out.push({
      productId: pid,
      qtyMilli,
      valuePaisa: (qtyMilli * avg + 500n) / 1000n,
      weightScaled: qtyMilli * BigInt(p.weightGrams),
    });
  }
  return out;
}

/** The basis value each resolved line contributes under the chosen basis. */
function basisOf(basis: LandedBasis, l: ResolvedLine): bigint {
  return basis === "VALUE" ? l.valuePaisa : basis === "QTY" ? l.qtyMilli : l.weightScaled;
}

export async function postLandedCostSheet(
  tx: DbTx,
  input: PostSheetInput
): Promise<{ sheetId: string; sheetNo: string }> {
  const totalPaisa = input.heads.reduce((a, h) => a + h.amountPaisa, 0n);
  if (input.heads.length === 0 || totalPaisa <= 0n)
    throw new UserError("Add at least one cost head with a positive amount.", 422, "LCS_BAD_HEADS");
  for (const h of input.heads) {
    if (!LANDED_HEADS.includes(h.head)) throw new UserError("Unknown cost head.", 422, "LCS_BAD_HEAD");
    if (h.amountPaisa < 0n) throw new UserError("Cost head amounts cannot be negative.", 422, "LCS_BAD_HEAD");
  }

  const ac = await accountMap(tx, input.companyId);
  const lines = await resolveLines(tx, input.companyId, input.branchId, input);
  const basisVals = lines.map((l) => basisOf(input.basis, l));

  // Every line must have stock on hand — you cannot capitalize cost into
  // zero units (adjustStockCost would throw anyway; fail early, naming it).
  for (const l of lines) {
    const [level] = await tx
      .select({ qty: stockLevels.qty })
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, l.productId), eq(stockLevels.branchId, input.branchId)))
      .limit(1);
    if (!level || level.qty <= 0n) {
      const [p] = await tx
        .select({ name: products.name })
        .from(products)
        .where(eq(products.id, l.productId))
        .limit(1);
      throw new UserError(
        `Cannot allocate landed cost to "${p?.name ?? l.productId}": no stock on hand at this branch.`,
        422,
        "LCS_NO_STOCK"
      );
    }
  }

  const allocated = allocateLandedCost(totalPaisa, basisVals);

  // Bump each product's moving-average cost.
  for (let i = 0; i < lines.length; i++) {
    const share = allocated[i]!;
    if (share > 0n) await adjustStockCost(tx, input.branchId, lines[i]!.productId, share);
  }

  // Journal: Dr Inventory per product's inventory account (dust → 1200),
  // Cr Landed Cost Clearing. Mirrors the purchase-posting grouping.
  const prodAccts = await productAccounts(
    tx,
    input.companyId,
    lines.map((l) => l.productId)
  );
  const invDr = new Map<string, bigint>();
  for (let i = 0; i < lines.length; i++) {
    const share = allocated[i]!;
    if (share <= 0n) continue;
    const acct = prodAccts.get(lines[i]!.productId)?.inventory ?? ac[SYS.INVENTORY];
    invDr.set(acct, (invDr.get(acct) ?? 0n) + share);
  }
  const invDrLines: JournalLineInput[] = [...invDr.entries()].map(([accountId, debit]) => ({
    accountId,
    debit,
    credit: 0n,
  }));
  {
    const got = [...invDr.values()].reduce((a, v) => a + v, 0n);
    if (totalPaisa > got) invDrLines.push({ accountId: ac[SYS.INVENTORY], debit: totalPaisa - got, credit: 0n });
  }
  const sheetNo = await nextDocNo(tx, input.companyId, "LANDED_COST");
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Landed cost ${sheetNo} (${input.basis})${input.purchaseDocId ? " — linked bill/GRN" : ""}`,
    reference: sheetNo,
    source: "LANDED_COST",
    createdById: input.createdById,
    lines: [
      ...invDrLines,
      { accountId: ac[SYS.LANDED_COST_CLEARING], debit: 0n, credit: totalPaisa },
    ],
  });

  const sheetId = crypto.randomUUID();
  const now = new Date();
  await tx.insert(landedCostSheets).values({
    id: sheetId,
    companyId: input.companyId,
    branchId: input.branchId,
    sheetNo,
    date: input.date,
    purchaseDocId: input.purchaseDocId ?? null,
    basis: input.basis,
    status: "POSTED",
    totalPaisa,
    journalEntryId: entryId,
    idempotencyKey: input.idempotencyKey ?? null,
    createdById: input.createdById,
    createdAt: now,
    updatedAt: now,
  });
  await tx.insert(landedCostHeads).values(
    input.heads.map((h) => ({
      id: crypto.randomUUID(),
      sheetId,
      head: h.head,
      label: h.label?.trim() || null,
      amountPaisa: h.amountPaisa,
    }))
  );
  await tx.insert(landedCostLines).values(
    lines.map((l, i) => ({
      id: crypto.randomUUID(),
      sheetId,
      productId: l.productId,
      qtyMilli: l.qtyMilli,
      valuePaisa: l.valuePaisa,
      weightScaled: l.weightScaled,
      allocatedPaisa: allocated[i]!,
    }))
  );
  return { sheetId, sheetNo };
}

export type VoidSheetInput = {
  sheetId: string;
  companyId: string;
  branchId: string;
  date: Date;
  createdById: string;
};

/**
 * Read-only allocation preview. Runs the exact same line resolution +
 * allocation as postLandedCostSheet (linked bill/GRN or explicit products,
 * chosen basis) but writes nothing. Powers the wizard's preview step.
 */
export async function previewLandedCost(
  tx: DbTx,
  input: {
    companyId: string;
    branchId: string;
    purchaseDocId?: string | null;
    basis: LandedBasis;
    heads: SheetHeadInput[];
    lines: SheetLineInput[];
  }
): Promise<{
  lines: {
    productId: string;
    productName: string;
    sku: string | null;
    unit: string | null;
    qtyMilli: string;
    valuePaisa: string;
    weightScaled: string;
    basisValue: string;
    allocatedPaisa: string;
  }[];
  totalPaisa: string;
}> {
  const totalPaisa = input.heads.reduce((a, h) => a + h.amountPaisa, 0n);
  if (input.heads.length === 0 || totalPaisa <= 0n)
    throw new UserError("Add at least one cost head with a positive amount.", 422, "LCS_BAD_HEADS");
  const lines = await resolveLines(tx, input.companyId, input.branchId, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: new Date(),
    purchaseDocId: input.purchaseDocId ?? null,
    basis: input.basis,
    heads: input.heads,
    lines: input.lines,
    createdById: "",
  });
  const basisVals = lines.map((l) => basisOf(input.basis, l));
  const allocated = allocateLandedCost(totalPaisa, basisVals);
  const prodRows = await tx
    .select({ id: products.id, name: products.name, sku: products.sku, unit: products.unit })
    .from(products)
    .where(inArray(products.id, lines.map((l) => l.productId)));
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  return {
    lines: lines.map((l, i) => ({
      productId: l.productId,
      productName: prodMap.get(l.productId)?.name ?? l.productId,
      sku: prodMap.get(l.productId)?.sku ?? null,
      unit: prodMap.get(l.productId)?.unit ?? null,
      qtyMilli: l.qtyMilli.toString(),
      valuePaisa: l.valuePaisa.toString(),
      weightScaled: l.weightScaled.toString(),
      basisValue: basisVals[i]!.toString(),
      allocatedPaisa: allocated[i]!.toString(),
    })),
    totalPaisa: totalPaisa.toString(),
  };
}

/** Void a posted sheet: exact reversing journal + negative cost adjustments. */
export async function voidLandedCostSheet(tx: DbTx, input: VoidSheetInput): Promise<void> {
  const rows = await tx
    .select()
    .from(landedCostSheets)
    .where(and(eq(landedCostSheets.id, input.sheetId), eq(landedCostSheets.companyId, input.companyId)))
    .limit(1);
  const sheet = rows[0];
  if (!sheet) throw new UserError("Landed-cost sheet not found.", 404, "LCS_NOT_FOUND");
  if (sheet.status !== "POSTED") throw new UserError("Only posted sheets can be voided.", 422, "LCS_BAD_STATUS");

  const ac = await accountMap(tx, input.companyId);
  const lines = await tx.select().from(landedCostLines).where(eq(landedCostLines.sheetId, sheet.id));

  // Reverse the cost bumps first (throws a clear error when a product's
  // stock can't absorb its share back — the sheet stays posted).
  for (const l of lines) {
    if (l.allocatedPaisa > 0n) await adjustStockCost(tx, sheet.branchId, l.productId, -l.allocatedPaisa);
  }

  const prodAccts = await productAccounts(
    tx,
    input.companyId,
    lines.map((l) => l.productId)
  );
  const invCr = new Map<string, bigint>();
  for (const l of lines) {
    if (l.allocatedPaisa <= 0n) continue;
    const acct = prodAccts.get(l.productId)?.inventory ?? ac[SYS.INVENTORY];
    invCr.set(acct, (invCr.get(acct) ?? 0n) + l.allocatedPaisa);
  }
  const invCrLines: JournalLineInput[] = [...invCr.entries()].map(([accountId, credit]) => ({
    accountId,
    debit: 0n,
    credit,
  }));
  {
    const got = [...invCr.values()].reduce((a, v) => a + v, 0n);
    if (sheet.totalPaisa > got)
      invCrLines.push({ accountId: ac[SYS.INVENTORY], debit: 0n, credit: sheet.totalPaisa - got });
  }

  await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Void landed cost ${sheet.sheetNo} — reversal`,
    reference: sheet.sheetNo,
    source: "LANDED_COST_VOID",
    sourceId: sheet.id,
    createdById: input.createdById,
    lines: [
      { accountId: ac[SYS.LANDED_COST_CLEARING], debit: sheet.totalPaisa, credit: 0n },
      ...invCrLines,
    ],
  });

  await tx
    .update(landedCostSheets)
    .set({ status: "VOID", updatedAt: new Date() })
    .where(eq(landedCostSheets.id, sheet.id));
}
