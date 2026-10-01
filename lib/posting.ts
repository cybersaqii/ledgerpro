import { eq, and, inArray, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalLines,
  parties,
  payments,
  paymentAllocations,
  products,
  purchaseDocs,
  salesDocs,
  stockLevels,
  expenses,
  sundryReceipts,
} from "@/db/schema";
import { SYS, accountMap, nextDocNo } from "./setup";
import { productAccounts, recordStockDetails } from "./stock-ledger";
import type { DbTx } from "./db";
import type { ComputedItem } from "./totals";
import { UserError } from "./errors";
import { FIX3_SOURCES } from "./stock-adjust";
import { markStatementLineCreated } from "./statements";
import { explodeSalesStockMoves } from "./bundles";
import { addBatchStock, deductBatchStock, restoreBatchStock, restoreLineageBatches, deductLineageBatches, recordBatchUsage } from "./batches";
import { whtAmountPaisa } from "./wht";
import { recordWhtDeduction } from "./tax";
import { queueFbrInvoice, readFbrPosId } from "./fbr";

export type JournalLineInput = {
  accountId: string;
  debit: bigint;
  credit: bigint;
  partyId?: string | null;
  memo?: string;
  /** Module 13: project tag (rides on the line; never changes the balance). */
  projectId?: string | null;
};

/** Hard invariant: debits must equal credits, and total must be positive. */
export function assertBalanced(lines: JournalLineInput[]): void {
  const d = lines.reduce((a, l) => a + l.debit, 0n);
  const c = lines.reduce((a, l) => a + l.credit, 0n);
  if (d !== c) throw new Error(`Journal out of balance: debits ${d} ≠ credits ${c}`);
  if (d <= 0n) throw new Error("Journal total must be positive");
  for (const l of lines) {
    if (l.debit < 0n || l.credit < 0n) throw new Error("Negative journal amounts are not allowed");
    if (l.debit > 0n && l.credit > 0n) throw new Error("A line cannot have both debit and credit");
  }
}

export async function createJournal(
  tx: DbTx,
  opts: {
    companyId: string;
    branchId?: string;
    date: Date;
    memo: string;
    reference?: string;
    source: string;
    sourceId?: string;
    /** Module 5: printable voucher number (JV-YYYY-0001). */
    docNo?: string;
    /** Module 5: double-submit protection key (partial unique index). */
    idempotencyKey?: string;
    createdById: string;
    lines: JournalLineInput[];
  }
): Promise<string> {
  const lines = opts.lines.filter((l) => l.debit !== 0n || l.credit !== 0n);
  assertBalanced(lines);
  const entryId = crypto.randomUUID();
  await tx.insert(journalEntries).values({
    id: entryId,
    companyId: opts.companyId,
    branchId: opts.branchId,
    date: opts.date,
    memo: opts.memo,
    reference: opts.reference,
    source: opts.source,
    sourceId: opts.sourceId,
    docNo: opts.docNo ?? null,
    idempotencyKey: opts.idempotencyKey ?? null,
    createdById: opts.createdById,
  });
  await tx.insert(journalLines).values(
    lines.map((l) => ({
      id: crypto.randomUUID(),
      entryId,
      accountId: l.accountId,
      debit: l.debit,
      credit: l.credit,
      partyId: l.partyId ?? null,
      memo: l.memo,
      // Module 13: project tag on the line. Tagging never changes the
      // journal balance (assertBalanced ran above).
      projectId: l.projectId ?? null,
    }))
  );
  return entryId;
}

/**
 * Module 13 — stamp every line of a document's journal with the document's
 * project tag. Pure helper: the journal balance is unchanged by the tag.
 */
export function withProject(
  lines: JournalLineInput[],
  projectId: string | null | undefined
): JournalLineInput[] {
  if (!projectId) return lines;
  return lines.map((l) => ({ ...l, projectId }));
}

export type StockMove = {
  productId: string;
  qtyMilli: bigint; // positive = stock in, negative = stock out
  avgCostPaisa: bigint;
  unitCostPaisa?: bigint; // for stock in: purchase rate per unit
};

/** Apply stock moves inside the transaction. Throws on insufficient stock.
 *  Returns the value moved at average cost, split into out (sales/usage) and
 *  in (returns) so callers can book matching COGS entries, plus per-move
 *  details (running balance + average after the move) for the Module 4
 *  stock-movement ledger. */
export type StockMoveDetail = {
  productId: string;
  branchId: string;
  qtyMilli: bigint;
  qtyAfter: bigint;
  avgAfter: bigint;
  /** Paisa value moved at average cost (half-up). */
  valueMoved: bigint;
};

export async function applyStock(
  tx: DbTx,
  branchId: string,
  moves: StockMove[]
): Promise<{ cogsOut: bigint; cogsIn: bigint; details: StockMoveDetail[] }> {
  let cogsOut = 0n;
  let cogsIn = 0n;
  const details: StockMoveDetail[] = [];
  for (const m of moves) {
    const rows = await tx
      .select()
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, m.productId), eq(stockLevels.branchId, branchId)))
      .limit(1);
    const level = rows[0];
    const current = level?.qty ?? 0n;
    const avg = level?.avgCost ?? m.avgCostPaisa;
    const next = current + m.qtyMilli;
    if (next < 0n) {
      const p = await tx.select({ name: products.name }).from(products).where(eq(products.id, m.productId)).limit(1);
      throw new UserError(`Insufficient stock for "${p[0]?.name ?? "product"}"`, 422, "INSUFFICIENT_STOCK");
    }
    let newAvg = avg;
    if (m.qtyMilli > 0n && m.unitCostPaisa !== undefined) {
      // Half-up everywhere (matches COGS rounding below): sub-paisa fractions
      // round to the nearest paisa instead of truncating down.
      const currentValue = (current * avg + 500n) / 1000n;
      const inValue = (m.qtyMilli * m.unitCostPaisa + 500n) / 1000n;
      newAvg = next > 0n ? ((currentValue + inValue) * 1000n + next / 2n) / next : avg;
    }
    const valueMoved =
      m.qtyMilli < 0n
        ? ((-m.qtyMilli * avg + 500n) / 1000n) // half-up
        : ((m.qtyMilli * avg + 500n) / 1000n); // value restored at avg cost
    if (m.qtyMilli < 0n) {
      cogsOut += valueMoved;
    } else if (m.qtyMilli > 0n) {
      cogsIn += valueMoved;
    }
    if (level) {
      await tx.update(stockLevels).set({ qty: next, avgCost: newAvg }).where(eq(stockLevels.id, level.id));
    } else {
      await tx.insert(stockLevels).values({
        id: crypto.randomUUID(),
        productId: m.productId,
        branchId,
        qty: next,
        avgCost: newAvg,
      });
    }
    details.push({ productId: m.productId, branchId, qtyMilli: m.qtyMilli, qtyAfter: next, avgAfter: newAvg, valueMoved });
  }
  return { cogsOut, cogsIn, details };
}

/** Module 4: apply stock moves grouped by location. Each move carries the
 *  branch it belongs to (the line-level override, or the doc branch); moves
 *  are applied per branch so per-location balances stay exact. Returns the
 *  merged per-move details for the movement ledger. */
export async function applyStockByBranch(
  tx: DbTx,
  moves: (StockMove & { branch: string })[]
): Promise<{ cogsOut: bigint; cogsIn: bigint; details: StockMoveDetail[] }> {
  let cogsOut = 0n;
  let cogsIn = 0n;
  const details: StockMoveDetail[] = [];
  const byBranch = new Map<string, StockMove[]>();
  for (const m of moves) {
    const list = byBranch.get(m.branch) ?? [];
    const { branch: _branch, ...rest } = m;
    list.push(rest);
    byBranch.set(m.branch, list);
  }
  for (const [branchId, ms] of byBranch) {
    const r = await applyStock(tx, branchId, ms);
    cogsOut += r.cogsOut;
    cogsIn += r.cogsIn;
    details.push(...r.details);
  }
  return { cogsOut, cogsIn, details };
}

/** Cost-only stock adjustment: spreads a value variance (e.g. landed extra
 *  costs on a bill converted from a GRN) over the on-hand quantity, updating
 *  the moving-average cost without moving any units. */
export async function adjustStockCost(
  tx: DbTx,
  branchId: string,
  productId: string,
  variancePaisa: bigint
): Promise<void> {
  if (variancePaisa === 0n) return;
  const [level] = await tx
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.productId, productId), eq(stockLevels.branchId, branchId)))
    .limit(1);
  const qty = level?.qty ?? 0n;
  if (qty <= 0n)
    throw new UserError("Cannot adjust stock cost: no stock on hand for this product.", 422);
  const avg = level?.avgCost ?? 0n;
  const currentValue = (qty * avg + 500n) / 1000n;
  const newValue = currentValue + variancePaisa;
  if (newValue < 0n) throw new UserError("Cost adjustment would drive stock value negative.", 422);
  const newAvg = (newValue * 1000n + qty / 2n) / qty;
  if (level) {
    await tx.update(stockLevels).set({ avgCost: newAvg }).where(eq(stockLevels.id, level.id));
  }
}

async function bumpPartyBalance(tx: DbTx, partyId: string, delta: bigint): Promise<void> {
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} + ${delta}`, updatedAt: new Date() })
    .where(eq(parties.id, partyId));
}

// ─── Sales ─────────────────────────────────────────────────────

export type PostSalesInput = {
  companyId: string;
  branchId: string;
  partyId: string;
  docId: string;
  docNo: string;
  docType: "INVOICE" | "RETURN";
  date: Date;
  items: (ComputedItem & {
    trackStock: boolean;
    batchId?: string | null;
    /** Module 4: per-line location override; NULL/undefined = doc branch. */
    branchId?: string | null;
  })[];
  discountTotal: bigint;
  taxTotal: bigint;
  /** Sales-side freight charged to the customer (untaxed) → Freight Income 4020. */
  freightTotal?: bigint;
  grandTotal: bigint;
  createdById: string;
  /** Module 21: revenue-only posting — skip ALL stock movement for invoices
   *  converted from an already-dispatched challan (the no-double-deduct
   *  rule). The journal then carries revenue/tax/discount/freight only. */
  skipStock?: boolean;
  /** RETURN docs: the source INVOICE id, used to restore its exact batches. */
  sourceDocId?: string;
  /** Module 13: project tag — stamped on every journal line (balance unchanged). */
  projectId?: string | null;
};

export async function postSalesDoc(tx: DbTx, input: PostSalesInput): Promise<string> {
  const ac = await accountMap(tx, input.companyId);
  // Gross sales = sum of line net amounts (after item discounts, before doc discount).
  // The doc discount is booked separately to DISCOUNT_GIVEN so the journal balances
  // and gross sales stay visible in reports.
  const grossSales = input.items.reduce((a, i) => a + i.taxablePaisa, 0n);

  // Module 21: skipStock — revenue-only invoice (converted from a challan
  // that already deducted stock at dispatch). No bundle explosion, no batch
  // deduction, no stock levels, no movement rows, no COGS lines. The journal
  // below naturally carries revenue/tax/discount/freight only, because the
  // COGS groups are built from the (empty) movement details.
  const allDetails: StockMoveDetail[] = [];
  if (!input.skipStock) {
  // Bundle lines explode into their components for stock + COGS; the bundle
  // product itself never gets a stock movement. Plain lines pass through.
  // Insufficient component stock throws here, rolling back the whole doc.
  // Each exploded move carries the line's batch choice (plain lines only —
  // bundle explosion drops it, components use FIFO) and the line's location
  // override (Module 4: NULL = the doc branch).
  const exploded = await explodeSalesStockMoves(
    tx,
    input.companyId,
    input.items.map((i) => ({
      productId: i.productId,
      qtyMilli: i.qtyMilli,
      trackStock: i.trackStock,
      batchId: i.batchId ?? null,
      branchId: i.branchId ?? null,
    })),
    input.docType
  );
  const stockMoves = exploded.map((m) => ({
    productId: m.productId,
    qtyMilli: m.qtyMilli,
    avgCostPaisa: 0n,
    batchId: m.batchId,
    branchId: m.branchId || input.branchId,
  }));

  // Batch-tracked products, inside the same transaction as stock + journal:
  // - INVOICE deducts (explicit batch, or FIFO by expiry) and records the
  //   per-batch lineage in doc_batch_usage so returns can restore exactly.
  // - RETURN restores against the source invoice's lineage (M4). Documents
  //   posted before lineage existed restore stock_levels only (legacy path).
  for (const m of stockMoves) {
    if (input.docType === "INVOICE") {
      const used = await deductBatchStock(tx, input.companyId, m.productId, -m.qtyMilli, m.batchId);
      for (const u of used) {
        await recordBatchUsage(tx, input.companyId, input.docId, m.productId, u.batchId, -u.qtyMilli);
      }
    } else if (input.sourceDocId) {
      await restoreLineageBatches(tx, input.companyId, input.sourceDocId, m.productId, m.qtyMilli);
    } else if (m.batchId) {
      // Legacy path: a RETURN posted directly (no source doc, e.g. pre-lineage
      // documents) restores the explicitly chosen batch, as before — and now
      // records the lineage too, so the audit trail has no gaps.
      await restoreBatchStock(tx, input.companyId, m.productId, m.batchId, m.qtyMilli);
      await recordBatchUsage(tx, input.companyId, input.docId, m.productId, m.batchId, m.qtyMilli);
    }
  }

  // Module 4: apply stock per location (line-level branch overrides fall back
  // to the doc branch) and keep the per-move details for the movement ledger.
  const { details } = await applyStockByBranch(
    tx,
    stockMoves.map((m) => ({ ...m, branch: m.branchId }))
  );
  allDetails.push(...details);
  await recordStockDetails(
    tx,
    input.companyId,
    input.date,
    input.docType === "INVOICE" ? "INVOICE" : "RETURN",
    input.docId,
    input.docNo,
    allDetails
  );
  }

  // Module 4.1: per-product GL accounts — revenue grouped by revenue account,
  // COGS/inventory grouped by (cogs, inventory) account pair, each falling
  // back to the system accounts. With no custom accounts the journal is
  // byte-identical to the old aggregated one.
  const prodAccts = await productAccounts(
    tx,
    input.companyId,
    input.items.map((i) => i.productId).filter((p): p is string => !!p)
  );
  const revenueGroups = new Map<string, bigint>();
  for (const i of input.items) {
    const acct = i.productId ? prodAccts.get(i.productId)?.revenue ?? ac[SYS.SALES] : ac[SYS.SALES];
    revenueGroups.set(acct, (revenueGroups.get(acct) ?? 0n) + i.taxablePaisa);
  }
  const cogsGroups = new Map<string, { cogs: string; inventory: string; amount: bigint }>();
  for (const d of allDetails) {
    if (d.valueMoved <= 0n) continue;
    const pa = prodAccts.get(d.productId);
    const cogs = pa?.cogs ?? ac[SYS.COGS];
    const inv = pa?.inventory ?? ac[SYS.INVENTORY];
    const key = `${cogs}|${inv}`;
    const g = cogsGroups.get(key) ?? { cogs, inventory: inv, amount: 0n };
    g.amount += d.valueMoved;
    cogsGroups.set(key, g);
  }
  const cogsLines: JournalLineInput[] = [...cogsGroups.values()].flatMap((g) =>
    input.docType === "INVOICE"
      ? [
          { accountId: g.cogs, debit: g.amount, credit: 0n },
          { accountId: g.inventory, debit: 0n, credit: g.amount },
        ]
      : [
          { accountId: g.inventory, debit: g.amount, credit: 0n },
          { accountId: g.cogs, debit: 0n, credit: g.amount },
        ]
  );

  const lines: JournalLineInput[] =
    input.docType === "INVOICE"
      ? [
          { accountId: ac[SYS.AR], debit: input.grandTotal, credit: 0n, partyId: input.partyId },
          ...[...revenueGroups.entries()].map(([accountId, credit]) => ({ accountId, debit: 0n, credit })),
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: input.taxTotal }] : []),
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_GIVEN], debit: input.discountTotal, credit: 0n }] : []),
          // Freight charged to the customer is income (SYS 4020), never part
          // of sales revenue. AR already carries grandTotal (freight
          // included), so this line only reclassifies the freight slice.
          ...((input.freightTotal ?? 0n) > 0n
            ? [{ accountId: ac[SYS.FREIGHT_INCOME], debit: 0n, credit: input.freightTotal ?? 0n }]
            : []),
          ...cogsLines,
        ]
      : [
          { accountId: ac[SYS.SALES_RETURN], debit: grossSales, credit: 0n },
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: input.taxTotal, credit: 0n }] : []),
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_GIVEN], debit: 0n, credit: input.discountTotal }] : []),
          { accountId: ac[SYS.AR], debit: 0n, credit: input.grandTotal, partyId: input.partyId },
          ...cogsLines,
        ];

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.docType === "INVOICE" ? `Sales invoice ${input.docNo}` : `Sales return ${input.docNo}`,
    reference: input.docNo,
    source: "SALES",
    sourceId: input.docId,
    createdById: input.createdById,
    lines: withProject(lines, input.projectId),
  });

  await bumpPartyBalance(tx, input.partyId, input.docType === "INVOICE" ? input.grandTotal : -input.grandTotal);

  // Module 7.1 — enqueue the FBR digital-invoice payload. The sync engine is
  // DISABLED (HARD RULE): the row is stored at status DISABLED for a future
  // live engine; nothing here performs any network call.
  if (input.docType === "INVOICE" || input.docType === "RETURN") {
    const posId = await readFbrPosId(tx, input.companyId);
    const prodIds = [...new Set(input.items.map((i) => i.productId).filter((p): p is string => !!p))];
    const pctById = new Map<string, string | null>();
    if (prodIds.length > 0) {
      const prodRows = await tx
        .select({ id: products.id, pctCode: products.pctCode })
        .from(products)
        .where(and(eq(products.companyId, input.companyId), inArray(products.id, prodIds)));
      for (const r of prodRows) pctById.set(r.id, r.pctCode);
    }
    await queueFbrInvoice(tx, {
      companyId: input.companyId,
      docType: input.docType === "RETURN" ? "SALES_RETURN" : "SALES_INVOICE",
      docId: input.docId,
      docNo: input.docNo,
      date: input.date,
      posId,
      items: input.items.map((i) => ({
        pctCode: i.productId ? (pctById.get(i.productId) ?? null) : null,
        description: i.description,
        quantity: Number(i.qtyMilli / 1000n),
        saleValuePaisa: i.taxablePaisa,
        taxChargedPaisa: i.taxAmountPaisa,
        rateBps: i.taxBps,
      })),
    });
  }
  return entryId;
}

// ─── Purchases ─────────────────────────────────────────────────

export type ExtraCostInput = { label: string; amount: bigint };

export type PostPurchaseInput = {
  companyId: string;
  branchId: string;
  partyId: string;
  docId: string;
  docNo: string;
  docType: "BILL" | "RETURN";
  date: Date;
  items: (ComputedItem & {
    trackStock: boolean;
    /** Purchase bill: optional batch_no + expiry_date to track this receipt. */
    batchNo?: string | null;
    expiryDate?: string | null;
    /** Purchase return: optional batch to deduct the returned qty from. */
    batchId?: string | null;
    /** Module 4: per-line location override; NULL/undefined = doc branch. */
    branchId?: string | null;
  })[];
  discountTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  createdById: string;
  /** Module 13: project tag — stamped on every journal line (balance unchanged). */
  projectId?: string | null;
  /** Landed extra costs (freight, labour): distributed into stock unit cost. */
  extraCosts?: ExtraCostInput[];
  /** How the extra costs were paid: cash/bank account, or added to the supplier bill. */
  extraCostPaidFrom?: "CASH" | "SUPPLIER";
  extraCostAccountId?: string;
  /** RETURN docs: the source BILL id, used to deduct from its exact batches. */
  sourceDocId?: string;
  /** BILL: withholding-tax deducted on this bill (Cr WHT Payable 2100; reduces the AP credit). */
  whtAmount?: bigint;
  /** BILL: the WHT rate (bps) and register section (e.g. 153-GOODS) for the
   *  Module 7 WHT Deduction Register. Optional — the register derives the
   *  section from the supplier's WHT category when absent. */
  whtBps?: number;
  whtSection?: string;
  /**
   * BILL converted from a GRN: the GRNI accrual (2002) this bill clears.
   * Replaces the Inventory debit — the stock already came in via the GRN.
   * The bill's goods value must equal the accrual exactly (rates are locked
   * to the GRN); only landed extra costs may add to inventory cost.
   */
  grnClearing?: { accruedPaisa: bigint };
  /** RETURN docs: false = pure-ledger return, no stock movement (Module 2.6). */
  deductFromInventory?: boolean;
};

/** Per-line landed extra cost allocation (same order as input.items). */
export type LandedCost = { index: number; extraCost: bigint };

/** Split a landed extra-cost total across stock lines in proportion to line value.
 *  Rounding remainder goes to the last line so the parts always sum exactly. */
export function distributeExtraCost(nets: bigint[], totalExtra: bigint): bigint[] {
  const out = nets.map(() => 0n);
  const base = nets.reduce((a, n) => a + n, 0n);
  if (totalExtra <= 0n || base <= 0n || nets.length === 0) return out;
  let assigned = 0n;
  for (let j = 0; j < nets.length; j++) {
    if (j === nets.length - 1) {
      out[j] = totalExtra - assigned;
    } else {
      out[j] = (nets[j]! * totalExtra) / base;
      assigned += out[j]!;
    }
  }
  return out;
}

export async function postPurchaseDoc(tx: DbTx, input: PostPurchaseInput): Promise<string> {
  const ac = await accountMap(tx, input.companyId);

  // Landed extra costs (freight, labour): only on bills, distributed over
  // stock-tracked lines in proportion to line value so the moving average
  // unit cost absorbs them.
  const extraCosts = (input.extraCosts ?? []).filter((c) => c.amount > 0n);
  const totalExtra = extraCosts.reduce((a, c) => a + c.amount, 0n);
  if (totalExtra > 0n && input.docType !== "BILL")
    throw new UserError("Extra costs can only be added to a purchase bill.");

  // Module 2: new posting options.
  const whtAmount = input.whtAmount ?? 0n;
  if (whtAmount < 0n) throw new UserError("WHT amount cannot be negative.", 422);
  if (whtAmount > 0n && input.docType !== "BILL")
    throw new UserError("WHT can only be deducted on a purchase bill.", 422);
  const fromGrn = input.docType === "BILL" && !!input.grnClearing;
  if (input.grnClearing && input.docType !== "BILL")
    throw new UserError("GRNI clearing only applies to purchase bills.", 422);
  const deductStock = input.docType === "RETURN" ? (input.deductFromInventory ?? true) : true;
  if (whtAmount > input.grandTotal)
    throw new UserError("WHT cannot exceed the bill total.", 422);

  let stockNet = 0n;
  let nonStockNet = 0n;
  const stockMoves: (StockMove & { branch: string })[] = [];
  const stockNets: bigint[] = [];
  const stockItemIdx: number[] = [];
  input.items.forEach((i, idx) => {
    const net = i.taxablePaisa;
    if (i.productId && i.trackStock) {
      stockNet += net;
      stockNets.push(net);
      stockItemIdx.push(idx);
    } else {
      nonStockNet += net;
    }
  });
  if (totalExtra > 0n && stockNets.length === 0)
    throw new UserError("Extra costs need at least one stock-tracked item.");
  // GRN-sourced bills carry the GRN's exact goods value: the bill's goods
  // nets must equal the accrual, otherwise the GRNI would never clear.
  if (fromGrn && stockNet + nonStockNet !== input.grnClearing!.accruedPaisa)
    throw new UserError("Bill lines must match the GRN — rates are locked to the received note.", 422);
  const landed = distributeExtraCost(stockNets, totalExtra); // per stock line, same order
  const landedByItem = new Map<number, bigint>();
  stockItemIdx.forEach((idx, j) => landedByItem.set(idx, landed[j] ?? 0n));

  for (let idx = 0; idx < input.items.length; idx++) {
    const i = input.items[idx]!;
    // GRN-sourced bills move no stock — the GRN already received it. Landed
    // extra costs still lift the unit cost via adjustStockCost below.
    if (fromGrn) continue;
    // Pure-ledger returns (Module 2.6): no stock movement at all.
    if (input.docType === "RETURN" && !deductStock) continue;
    if (i.productId && i.trackStock) {
      const net = i.taxablePaisa + (landedByItem.get(idx) ?? 0n);
      stockMoves.push({
        productId: i.productId,
        qtyMilli: input.docType === "BILL" ? i.qtyMilli : -i.qtyMilli,
        avgCostPaisa: 0n,
        unitCostPaisa: i.qtyMilli > 0n ? (net * 1000n + i.qtyMilli / 2n) / i.qtyMilli : 0n, // half-up
        // Module 4: per-line location override (NULL = doc branch).
        branch: i.branchId ?? input.branchId,
      });
    }
  }

  // Batch tracking, inside the same transaction as the stock + journal writes:
  // - BILL with a batch_no: create the batch row or top it up (expiry format
  //   validated inside addBatchStock — a bad date aborts the whole bill), and
  //   record the lineage in doc_batch_usage so returns deduct the same batches.
  // - RETURN: deduct from the source bill's batches via lineage (M4). Without
  //   lineage (pre-migration docs) fall back to an explicitly chosen batch.
  // GRN-sourced bills and pure-ledger returns (Module 2) never touch batches:
  // the GRN already created them, and a ledger-only return moves no stock.
  for (const i of input.items) {
    if (!i.productId || !i.trackStock) continue;
    if (fromGrn) continue;
    if (input.docType === "RETURN" && !deductStock) continue;
    if (input.docType === "BILL") {
      if (i.batchNo && i.batchNo.trim()) {
        const newBatchId = await addBatchStock(tx, input.companyId, i.productId, i.batchNo, i.expiryDate ?? null, i.qtyMilli);
        if (newBatchId) {
          await recordBatchUsage(tx, input.companyId, input.docId, i.productId, newBatchId, i.qtyMilli);
        }
      }
    } else if (input.sourceDocId) {
      // Record the per-batch deduction against this return's own doc id so a
      // later void can restore the exact batches (Module 2.6).
      await deductLineageBatches(tx, input.companyId, input.sourceDocId, i.productId, i.qtyMilli, input.docId);
    } else if (i.batchId) {
      // Direct purchase return against an explicit batch: deduct it and
      // record the lineage (negative = batch deduction), like bills do.
      await deductBatchStock(tx, input.companyId, i.productId, i.qtyMilli, i.batchId);
      await recordBatchUsage(tx, input.companyId, input.docId, i.productId, i.batchId, -i.qtyMilli);
    }
  }

  const { cogsOut: stockCostOut, details: purchaseDetails } = await applyStockByBranch(tx, stockMoves);
  // For purchase returns, inventory leaves at average cost (stockCostOut), not at
  // the return document's rate. Any difference is a price gain/loss vs cost.
  const priceDiff = stockNet - stockCostOut;

  // Module 4: movement ledger — bills and stock-deducting returns.
  if (input.docType === "BILL" || deductStock) {
    await recordStockDetails(
      tx,
      input.companyId,
      input.date,
      input.docType === "BILL" ? "BILL" : "RETURN",
      input.docId,
      input.docNo,
      purchaseDetails
    );
  }

  // Module 4.1: inventory debits grouped by each product's inventory account
  // (fallback SYS.INVENTORY 1200). Direct bills debit net+landed per product;
  // GRN-sourced bills debit only the landed extra costs (the GRN already
  // booked the goods value, possibly to the same per-product accounts).
  const prodAccts = await productAccounts(
    tx,
    input.companyId,
    input.items.map((i) => i.productId).filter((p): p is string => !!p)
  );
  const invAcctOf = (productId: string) => prodAccts.get(productId)?.inventory ?? ac[SYS.INVENTORY];
  const invDr = new Map<string, bigint>();
  for (const idx of stockItemIdx) {
    const i = input.items[idx]!;
    const acct = invAcctOf(i.productId!);
    const amt = fromGrn ? (landedByItem.get(idx) ?? 0n) : i.taxablePaisa + (landedByItem.get(idx) ?? 0n);
    if (amt > 0n) invDr.set(acct, (invDr.get(acct) ?? 0n) + amt);
  }
  const invDrLines: JournalLineInput[] = [...invDr.entries()].map(([accountId, debit]) => ({
    accountId,
    debit,
    credit: 0n,
  }));
  // Safety: landed-cost distribution can leave dust undistributed when line
  // nets are zero (distributeExtraCost returns zeros); the remainder keeps
  // the exact old totals on the fallback inventory account.
  {
    const expected = fromGrn ? totalExtra : stockNet + totalExtra;
    const got = [...invDr.values()].reduce((a, v) => a + v, 0n);
    if (expected > got) {
      invDrLines.push({ accountId: ac[SYS.INVENTORY], debit: expected - got, credit: 0n });
    }
  }
  // Purchase returns: inventory leaves at average cost, grouped per account.
  const invCr = new Map<string, bigint>();
  for (const d of purchaseDetails) {
    if (d.valueMoved <= 0n) continue;
    const acct = invAcctOf(d.productId);
    invCr.set(acct, (invCr.get(acct) ?? 0n) + d.valueMoved);
  }
  const invCrLines: JournalLineInput[] = [...invCr.entries()].map(([accountId, credit]) => ({
    accountId,
    debit: 0n,
    credit,
  }));

  // GRN-sourced bills move no stock, but landed extra costs still lift the
  // received stock's unit cost (the GRN already holds the quantities).
  if (fromGrn && totalExtra > 0n) {
    for (const idx of stockItemIdx) {
      const i = input.items[idx]!;
      const share = landedByItem.get(idx) ?? 0n;
      if (share > 0n && i.productId) await adjustStockCost(tx, i.branchId ?? input.branchId, i.productId, share);
    }
  }

  // Extra-cost credit side: cash/bank account, or added to the supplier's payable.
  let extraCredit: JournalLineInput | null = null;
  if (totalExtra > 0n) {
    const paidFrom = input.extraCostPaidFrom ?? "CASH";
    if (paidFrom === "SUPPLIER") {
      extraCredit = { accountId: ac[SYS.AP], debit: 0n, credit: totalExtra, partyId: input.partyId };
    } else {
      const bankRows = await tx
        .select()
        .from(bankAccounts)
        .where(
          input.extraCostAccountId
            ? and(eq(bankAccounts.id, input.extraCostAccountId), eq(bankAccounts.companyId, input.companyId))
            : and(eq(bankAccounts.companyId, input.companyId), eq(bankAccounts.kind, "CASH"))
        )
        .limit(1);
      const bank = bankRows[0];
      if (!bank) throw new UserError("Cash/bank account for extra costs not found.");
      extraCredit = { accountId: bank.accountId, debit: 0n, credit: totalExtra };
      await tx
        .update(bankAccounts)
        .set({ balance: sql`${bankAccounts.balance} - ${totalExtra}` })
        .where(eq(bankAccounts.id, bank.id));
    }
  }

  const extraMemo = extraCosts.length > 0
    ? ` (+ ${extraCosts.map((c) => c.label).join(", ")} Rs ${(totalExtra / 100n).toLocaleString()})`
    : "";
  // Module 2.4 — bill postings:
  //   direct:  Dr Inventory-or-Purchases / Dr Input Tax / Cr WHT Payable (2100) / Cr AP
  //   from GRN: Dr GRNI Accrual (clears the receipt accrual) / Dr Inventory
  //            (landed extra costs only) / Dr Input Tax / Cr WHT Payable / Cr AP
  const billLines: JournalLineInput[] = fromGrn
    ? [
        { accountId: ac[SYS.GRNI_ACCRUAL], debit: input.grnClearing!.accruedPaisa, credit: 0n, partyId: input.partyId },
        ...invDrLines,
        ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxTotal, credit: 0n }] : []),
        ...(whtAmount > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: whtAmount, partyId: input.partyId }] : []),
        { accountId: ac[SYS.AP], debit: 0n, credit: input.grandTotal - whtAmount, partyId: input.partyId },
        ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: 0n, credit: input.discountTotal }] : []),
        ...(extraCredit ? [extraCredit] : []),
      ]
    : [
        ...invDrLines,
        ...(nonStockNet > 0n ? [{ accountId: ac[SYS.PURCHASES], debit: nonStockNet, credit: 0n }] : []),
        ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxTotal, credit: 0n }] : []),
        ...(whtAmount > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: whtAmount, partyId: input.partyId }] : []),
        { accountId: ac[SYS.AP], debit: 0n, credit: input.grandTotal - whtAmount, partyId: input.partyId },
        ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: 0n, credit: input.discountTotal }] : []),
        ...(extraCredit ? [extraCredit] : []),
      ];

  // Module 2.6 — purchase returns: with deductFromInventory the inventory
  // leaves at average cost (existing behaviour); without it the return is a
  // pure-ledger document and stock lines credit Purchases like non-stock.
  const returnLines: JournalLineInput[] = deductStock
    ? [
        { accountId: ac[SYS.AP], debit: input.grandTotal, credit: 0n, partyId: input.partyId },
        ...invCrLines,
        ...(nonStockNet > 0n ? [{ accountId: ac[SYS.PURCHASES], debit: 0n, credit: nonStockNet }] : []),
        ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: 0n, credit: input.taxTotal }] : []),
        ...(priceDiff !== 0n
          ? [
              {
                accountId: ac[SYS.DISCOUNT_RECEIVED],
                debit: priceDiff < 0n ? -priceDiff : 0n,
                credit: priceDiff > 0n ? priceDiff : 0n,
              },
            ]
          : []),
        ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: input.discountTotal, credit: 0n }] : []),
      ]
    : [
        { accountId: ac[SYS.AP], debit: input.grandTotal, credit: 0n, partyId: input.partyId },
        ...((stockNet + nonStockNet) > 0n
          ? [{ accountId: ac[SYS.PURCHASES], debit: 0n, credit: stockNet + nonStockNet }]
          : []),
        ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: 0n, credit: input.taxTotal }] : []),
        ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: input.discountTotal, credit: 0n }] : []),
      ];

  const lines: JournalLineInput[] = input.docType === "BILL" ? billLines : returnLines;
  assertBalanced(lines);

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.docType === "BILL" ? `Purchase bill ${input.docNo}${extraMemo}` : `Purchase return ${input.docNo}`,
    reference: input.docNo,
    source: "PURCHASE",
    sourceId: input.docId,
    createdById: input.createdById,
    lines: withProject(lines, input.projectId),
  });

  // The AP credit is net of WHT (the withheld tax is owed to the tax
  // authority, not the supplier), so the party balance moves by the net too.
  const apNet = input.grandTotal - whtAmount;
  await bumpPartyBalance(tx, input.partyId, input.docType === "BILL" ? apNet : -input.grandTotal);
  // Module 7.2 — every bill-time WHT deduction lands in the WHT Deduction
  // Register (the journal already carries Cr 2100 via Module 2).
  if (input.docType === "BILL" && whtAmount > 0n) {
    await recordWhtDeduction(tx, {
      companyId: input.companyId,
      date: input.date,
      kind: "BILL",
      docId: input.docId,
      journalEntryId: entryId,
      partyId: input.partyId,
      taxSection: input.whtSection ?? "",
      rateBps: input.whtBps ?? 0,
      // Same base the bill routes use: net goods/services value, excl. sales tax.
      grossPaisa: input.items.reduce((a, i) => a + i.taxablePaisa, 0n),
      whtPaisa: whtAmount,
      createdById: input.createdById,
    });
  }
  if (totalExtra > 0n && (input.extraCostPaidFrom ?? "CASH") === "SUPPLIER") {
    // extra cost added to the supplier's bill increases what we owe them
    await bumpPartyBalance(tx, input.partyId, totalExtra);
  }
  return entryId;
}

// ─── Payments ──────────────────────────────────────────────────

export type AllocationInput = { docId: string; docKind: "SALES" | "PURCHASE"; amount: bigint };

export type PostPaymentInput = {
  /** Optional explicit id (sync push uses the client's refId); defaults to a fresh UUID. */
  id?: string;
  companyId: string;
  branchId: string;
  kind: "RECEIPT" | "PAYMENT";
  partyId: string;
  bankAccountId: string;
  date: Date;
  amount: bigint;
  method: string;
  reference?: string;
  notes?: string;
  /**
   * Proposed voucher number (REC-0001 / PAY-0001). Only the sync path sets
   * this, after resolving availability; every other caller gets a fresh
   * number from nextDocNo().
   */
  docNo?: string;
  allocations: AllocationInput[];
  createdById: string;
  /** Module 13: project tag — stamped on every journal line (balance unchanged). */
  projectId?: string | null;
  /** Module 14: POS session tag — links counter receipts/refunds to the open shift. */
  posSessionId?: string | null;
  /** Double-submit protection: stored on the row; the route checks it first (migration 0031). */
  idempotencyKey?: string;
  /**
   * Module 7.2 — WHT deducted at payment/receipt time. `amount` stays the
   * GROSS being settled; the bank/cash leg moves net (amount − WHT) and the
   * withheld tax posts Cr 2100 (supplier payment) / Dr 2100 (customer
   * receipt, a tax credit), party-tagged — the Module 2 pattern, extended.
   */
  wht?: { section: string; rateBps: number };
};

/**
 * Module 10 — exchange gain/loss on settlement of a foreign-currency document.
 *
 * When an allocation settles (PAID) a non-PKR invoice/bill, the PKR actually
 * received/paid almost never equals the PKR the document carried at its
 * invoice rate (rate moved between invoice and payment). The difference is a
 * realized exchange gain/loss:
 *   diff = amountPaid − (grandTotal − returnedTotal − writtenOffAmount)
 * which equals (settled foreign × payment-date rate) − (settled foreign ×
 * doc rate), up to per-line rounding absorbed here by design.
 *
 * SALES (receipt):  diff > 0 → Dr AR / Cr Exchange Gain (4120)
 *                   diff < 0 → Dr Exchange Loss (6040) / Cr AR
 * PURCHASE (payment): diff > 0 → Dr Exchange Loss (6040) / Cr AP
 *                     diff < 0 → Dr AP / Cr Exchange Gain (4120)
 * Always balanced; party-tagged so party ledgers stay exact. PKR documents
 * always have diff = 0 and post nothing.
 */
async function postFxSettlement(
  tx: DbTx,
  args: {
    companyId: string;
    branchId: string;
    date: Date;
    createdById: string;
    paymentId: string;
    docKind: "SALES" | "PURCHASE";
    docNo: string;
    currencyCode: string | null;
    grandTotal: bigint;
    amountPaid: bigint;
    returnedTotal: bigint;
    writtenOffAmount: bigint;
    partyId: string;
  }
): Promise<void> {
  const code = (args.currencyCode || "PKR").toUpperCase();
  if (code === "PKR") return;
  const expected = args.grandTotal - args.returnedTotal - args.writtenOffAmount;
  const diff = args.amountPaid - expected;
  if (diff === 0n) return;
  const ac = await accountMap(tx, args.companyId);
  const arApAccount = args.docKind === "SALES" ? ac[SYS.AR] : ac[SYS.AP];
  const gainAccount = ac[SYS.EXCHANGE_GAIN];
  const lossAccount = ac[SYS.EXCHANGE_LOSS];
  const isGain = args.docKind === "SALES" ? diff > 0n : diff < 0n;
  const amt = diff > 0n ? diff : -diff;
  // Gain: we came out ahead in PKR (collected more / paid less).
  // Loss: we came out behind in PKR (collected less / paid more).
  const lines =
    args.docKind === "SALES"
      ? isGain
        ? [
            { accountId: arApAccount, debit: amt, credit: 0n, partyId: args.partyId },
            { accountId: gainAccount, debit: 0n, credit: amt },
          ]
        : [
            { accountId: lossAccount, debit: amt, credit: 0n },
            { accountId: arApAccount, debit: 0n, credit: amt, partyId: args.partyId },
          ]
      : isGain
        ? [
            { accountId: arApAccount, debit: amt, credit: 0n, partyId: args.partyId },
            { accountId: gainAccount, debit: 0n, credit: amt },
          ]
        : [
            { accountId: lossAccount, debit: amt, credit: 0n },
            { accountId: arApAccount, debit: 0n, credit: amt, partyId: args.partyId },
          ];
  await createJournal(tx, {
    companyId: args.companyId,
    branchId: args.branchId,
    date: args.date,
    memo: `Exchange ${isGain ? "gain" : "loss"} on settlement of ${args.docNo} (${code})`,
    source: "FX_SETTLEMENT",
    sourceId: args.paymentId,
    createdById: args.createdById,
    lines,
  });
}

/** Allocate part of a payment to one document: bumps amountPaid, flips
 *  POSTED/PARTIAL → PARTIAL/PAID, and writes the payment_allocations row.
 *  Shared by postPayment and PDC auto-allocation on clear.
 *
 *  Module 10: when `settleFx` is provided and this allocation SETTLES a
 *  foreign-currency document (status flips to PAID), an exchange gain/loss
 *  journal is auto-posted for the difference between the PKR actually
 *  received/paid and the PKR the document carried at its invoice rate:
 *    diff = amountPaid − (grandTotal − returnedTotal − writtenOffAmount)
 *  SALES: diff>0 → Dr AR / Cr Exchange Gain 4120; diff<0 → Dr Exchange Loss 6040 / Cr AR.
 *  PURCHASE: diff>0 → Dr Exchange Loss 6040 / Cr AP; diff<0 → Dr AP / Cr Exchange Gain 4120.
 *  Partial allocations never post FX — only the settling one does. PKR docs
 *  always have diff = 0 and post nothing. The journal reverses with the
 *  payment void (lib/payment-void.ts).
 */
export async function allocatePaymentToDoc(
  tx: DbTx,
  opts: {
    companyId: string;
    paymentId: string;
    partyId: string;
    docKind: "SALES" | "PURCHASE";
    docId: string;
    amount: bigint;
    /** Module 10: context for the FX settlement journal (required to post it). */
    settleFx?: { branchId: string; date: Date; createdById: string };
  }
): Promise<void> {
  if (opts.amount <= 0n) throw new UserError("Allocation amounts must be positive");
  if (opts.docKind === "SALES") {
    const rows = await tx
      .select()
      .from(salesDocs)
      .where(and(eq(salesDocs.id, opts.docId), eq(salesDocs.companyId, opts.companyId)))
      .limit(1);
    const doc = rows[0];
    if (!doc || doc.partyId !== opts.partyId) throw new UserError("Invalid sales document for allocation");
    // Module 6: never allocate to an unposted document (DRAFT, PENDING_APPROVAL,
    // REJECTED) — its journal doesn't exist, so the allocation would mark a
    // ghost document paid while the money sits nowhere.
    if (!["POSTED", "PARTIAL", "PAID"].includes(doc.status))
      throw new UserError(`Cannot allocate to ${doc.docNo}: it is not posted.`, 422, "DOC_NOT_POSTED");
    const remaining = doc.grandTotal - doc.amountPaid - doc.returnedTotal;
    if (opts.amount > remaining) throw new UserError(`Allocation exceeds remaining balance of ${doc.docNo}`);
    const paid = doc.amountPaid + opts.amount;
    const netTotal = doc.grandTotal - doc.returnedTotal;
    const newStatus = paid >= netTotal ? "PAID" : "PARTIAL";
    await tx
      .update(salesDocs)
      .set({ amountPaid: paid, status: newStatus, updatedAt: new Date() })
      .where(eq(salesDocs.id, doc.id));
    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: opts.paymentId,
      partyId: opts.partyId,
      salesDocId: doc.id,
      amount: opts.amount,
    });
    // Module 10: FX gain/loss on settlement of a foreign-currency invoice.
    if (opts.settleFx && newStatus === "PAID") {
      await postFxSettlement(tx, {
        companyId: opts.companyId,
        branchId: opts.settleFx.branchId,
        date: opts.settleFx.date,
        createdById: opts.settleFx.createdById,
        paymentId: opts.paymentId,
        docKind: "SALES",
        docNo: doc.docNo,
        currencyCode: doc.currencyCode,
        grandTotal: doc.grandTotal,
        amountPaid: paid,
        returnedTotal: doc.returnedTotal ?? 0n,
        writtenOffAmount: doc.writtenOffAmount ?? 0n,
        partyId: opts.partyId,
      });
    }
  } else {
    const rows = await tx
      .select()
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, opts.docId), eq(purchaseDocs.companyId, opts.companyId)))
      .limit(1);
    const doc = rows[0];
    if (!doc || doc.partyId !== opts.partyId) throw new UserError("Invalid purchase document for allocation");
    // Module 6: never allocate to an unposted document (see sales-side note).
    if (!["POSTED", "PARTIAL", "PAID"].includes(doc.status))
      throw new UserError(`Cannot allocate to ${doc.docNo}: it is not posted.`, 422, "DOC_NOT_POSTED");
    const remaining = doc.grandTotal - doc.amountPaid - doc.returnedTotal;
    if (opts.amount > remaining) throw new UserError(`Allocation exceeds remaining balance of ${doc.docNo}`);
    const paid = doc.amountPaid + opts.amount;
    const netTotal = doc.grandTotal - doc.returnedTotal;
    const newStatus = paid >= netTotal ? "PAID" : "PARTIAL";
    await tx
      .update(purchaseDocs)
      .set({ amountPaid: paid, status: newStatus, updatedAt: new Date() })
      .where(eq(purchaseDocs.id, doc.id));
    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: opts.paymentId,
      partyId: opts.partyId,
      purchaseDocId: doc.id,
      amount: opts.amount,
    });
    // Module 10: FX gain/loss on settlement of a foreign-currency bill.
    if (opts.settleFx && newStatus === "PAID") {
      await postFxSettlement(tx, {
        companyId: opts.companyId,
        branchId: opts.settleFx.branchId,
        date: opts.settleFx.date,
        createdById: opts.settleFx.createdById,
        paymentId: opts.paymentId,
        docKind: "PURCHASE",
        docNo: doc.docNo,
        currencyCode: doc.currencyCode,
        grandTotal: doc.grandTotal,
        amountPaid: paid,
        returnedTotal: doc.returnedTotal ?? 0n,
        writtenOffAmount: doc.writtenOffAmount ?? 0n,
        partyId: opts.partyId,
      });
    }
  }
}

export async function postPayment(tx: DbTx, input: PostPaymentInput): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Payment amount must be positive");
  const ac = await accountMap(tx, input.companyId);

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new UserError("Bank/cash account not found");

  // M1: the PARTY's kind decides the subsidiary ledger (AR vs AP) — cash
  // direction comes from the payment kind. A customer cash refund (PAYMENT)
  // must hit AR, and a supplier refund received (RECEIPT) must hit AP;
  // deriving AR/AP from RECEIPT-vs-PAYMENT alone mis-posts both cases.
  const partyRows = await tx
    .select({ kind: parties.kind })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const party = partyRows[0];
  if (!party) throw new UserError("Party not found");
  const isCustomer = party.kind === "CUSTOMER";
  const arApAccount = isCustomer ? ac[SYS.AR] : ac[SYS.AP];
  const isReceipt = input.kind === "RECEIPT";

  // Receipt/voucher number (REC-0001 / PAY-0001) + journal deep-link id, both
  // known before the journal is written. The sync path may propose the
  // device's number (already availability-resolved); otherwise allocate fresh.
  const paymentId = input.id ?? crypto.randomUUID();
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, isReceipt ? "RECEIPT" : "PAYMENT"));

  const allocTotal = input.allocations.reduce((a, x) => a + x.amount, 0n);
  if (allocTotal > input.amount) throw new UserError("Allocated amount exceeds payment amount");
  // M1b: allocations may only settle the party's own document side — a
  // customer payment can never allocate to a purchase bill, and vice versa.
  // Refunds (customer PAYMENT, supplier RECEIPT) can never be allocated at
  // all: they are plain ledger movements, and allocating one would both move
  // cash and mark a document paid.
  const wantDocKind = isCustomer ? "SALES" : "PURCHASE";
  const isRefundFlow = isCustomer ? !isReceipt : isReceipt;
  if (isRefundFlow && input.allocations.length > 0) {
    throw new UserError("Refunds cannot be allocated to documents.");
  }
  for (const a of input.allocations) {
    if (a.amount <= 0n) throw new UserError("Allocation amounts must be positive");
    if (a.docKind !== wantDocKind)
      throw new UserError(
        isCustomer
          ? "Customer receipts/payments can only be allocated to sales invoices"
          : "Supplier receipts/payments can only be allocated to purchase bills"
      );
  }

  // Module 7.2 — WHT deducted at payment/receipt time. The amount stays the
  // GROSS being settled; the bank leg moves net and the withheld tax posts
  // to 2100 (the Module 2 WHT pattern, extended to payments/receipts).
  const whtSection = (input.wht?.section ?? "").trim();
  const whtBps = input.wht?.rateBps ?? 0;
  if (whtSection || whtBps > 0) {
    if (!whtSection) throw new UserError("WHT section is required when deducting tax.", 422);
    if (!Number.isInteger(whtBps) || whtBps < 0 || whtBps > 10000)
      throw new UserError("WHT rate must be between 0 and 100%.", 422);
    if (isRefundFlow) throw new UserError("WHT cannot be deducted on a refund.", 422);
  }
  const whtAmount = whtBps > 0 ? whtAmountPaisa(input.amount, whtBps) : 0n;
  if (whtAmount >= input.amount)
    throw new UserError("WHT cannot exceed the payment amount.", 422);
  if (whtAmount > 0n && !isReceipt && input.allocations.length > 0) {
    // A bill that already carries bill-time WHT (Module 2) must not be
    // deducted again at payment — that would double-count the tax.
    const billRows = await tx
      .select({ docNo: purchaseDocs.docNo, whtAmount: purchaseDocs.whtAmount })
      .from(purchaseDocs)
      .where(
        and(
          eq(purchaseDocs.companyId, input.companyId),
          inArray(
            purchaseDocs.id,
            input.allocations.map((a) => a.docId)
          )
        )
      );
    const dup = billRows.find((b) => (b.whtAmount ?? 0n) > 0n);
    if (dup)
      throw new UserError(
        `WHT was already deducted on bill ${dup.docNo}; deducting again would double-count the tax.`,
        422,
        "WHT_ALREADY_DEDUCTED"
      );
  }

  // Module 2.5 — vendor payments: the allocated part settles AP, the
  // unallocated remainder becomes an Advance to Suppliers asset (1110)
  // instead of sitting invisibly inside AP:
  //   Dr AP (allocated, party) / Dr Advance to Suppliers (unallocated) / Cr Bank (total)
  // Customer receipts keep the Module 1 design (advance stays inside AR as
  // negative balance); refunds are never allocated and keep plain postings.
  const isSupplierPayment = !isCustomer && !isReceipt && !isRefundFlow;
  const advanceAmount = isSupplierPayment ? input.amount - allocTotal : 0n;

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `${isReceipt ? "Receipt" : "Payment"}${input.reference ? ` ${input.reference}` : ""}`,
    reference: input.reference,
    source: "PAYMENT",
    sourceId: paymentId,
    createdById: input.createdById,
    lines: withProject(
      isReceipt
      ? [
          { accountId: bank.accountId, debit: input.amount - whtAmount, credit: 0n },
          // Module 7.2 — the customer withheld tax on our invoice: a tax
          // credit for us (Dr WHT 2100, party-tagged); AR settles at gross.
          ...(whtAmount > 0n
            ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: whtAmount, credit: 0n, partyId: input.partyId }]
            : []),
          { accountId: arApAccount, debit: 0n, credit: input.amount, partyId: input.partyId },
        ]
      : isSupplierPayment
        ? [
            // Module 2.5 — vendor payments: allocated part settles AP, the
            // unallocated remainder becomes an Advance to Suppliers asset.
            ...(allocTotal > 0n
              ? [{ accountId: arApAccount, debit: allocTotal, credit: 0n, partyId: input.partyId }]
              : []),
            ...(advanceAmount > 0n
              ? [{ accountId: ac[SYS.ADVANCE_SUPPLIERS], debit: advanceAmount, credit: 0n }]
              : []),
            // Module 7.2 — tax we withhold from the supplier is owed to the
            // tax authority (Cr WHT 2100, party-tagged); cash moves net.
            ...(whtAmount > 0n
              ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: whtAmount, partyId: input.partyId }]
              : []),
            { accountId: bank.accountId, debit: 0n, credit: input.amount - whtAmount },
          ]
        : [
            { accountId: arApAccount, debit: input.amount, credit: 0n, partyId: input.partyId },
            { accountId: bank.accountId, debit: 0n, credit: input.amount },
          ],
      input.projectId
    ),
  });

  await tx.insert(payments).values({
    id: paymentId,
    companyId: input.companyId,
    branchId: input.branchId,
    kind: input.kind,
    docNo,
    date: input.date,
    partyId: input.partyId,
    bankAccountId: input.bankAccountId,
    amount: input.amount,
    method: input.method,
    reference: input.reference,
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
    // Module 13: project tagging (journal lines carry the tag too).
    projectId: input.projectId ?? null,
    // Module 14: POS session tagging (shift summary source).
    posSessionId: input.posSessionId ?? null,
    // Module 7.2 — payment/receipt-time WHT (detail lives in wht_deductions).
    whtAmount,
    whtSection: whtAmount > 0n ? whtSection : null,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  // Module 7.2 — every payment/receipt-time WHT deduction lands in the
  // WHT Deduction Register (inside the same posting transaction).
  if (whtAmount > 0n) {
    await recordWhtDeduction(tx, {
      companyId: input.companyId,
      date: input.date,
      kind: input.kind,
      paymentId,
      journalEntryId: entryId,
      partyId: input.partyId,
      taxSection: whtSection,
      rateBps: whtBps,
      grossPaisa: input.amount,
      whtPaisa: whtAmount,
      createdById: input.createdById,
    });
  }

  for (const a of input.allocations) {
    await allocatePaymentToDoc(tx, {
      companyId: input.companyId,
      paymentId,
      partyId: input.partyId,
      docKind: a.docKind,
      docId: a.docId,
      amount: a.amount,
      // Module 10: FX gain/loss posts when an allocation settles a
      // foreign-currency document (inside this same posting transaction).
      settleFx: { branchId: input.branchId, date: input.date, createdById: input.createdById },
    });
  }

  // Party balance convention: positive = outstanding (customer owes us /
  // we owe the supplier). Receiving money moves the balance toward us,
  // paying out moves it away — on BOTH sides of the ledger:
  //   RECEIPT from customer → they owe less (−); from supplier → we owe more (+)
  //   PAYMENT to customer (refund) → they owe more (+); to supplier → we owe less (−)
  // Module 2.5: a vendor payment only relieves AP by its ALLOCATED part —
  // the unallocated remainder is an Advance to Suppliers asset, not AP relief.
  await bumpPartyBalance(
    tx,
    input.partyId,
    isSupplierPayment ? -allocTotal : isCustomer === isReceipt ? -input.amount : input.amount
  );
  // Module 7.2: cash actually moves NET of any withheld tax.
  const cashMoved = input.amount - whtAmount;
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${isReceipt ? cashMoved : -cashMoved}` })
    .where(eq(bankAccounts.id, bank.id));

  return { id: paymentId, docNo };
}

// ─── Expenses ──────────────────────────────────────────────────

export type PostExpenseInput = {
  /** Optional explicit id (sync push uses the client's refId); defaults to a fresh UUID. */
  id?: string;
  companyId: string;
  branchId: string;
  accountId: string;
  bankAccountId: string;
  date: Date;
  amount: bigint;
  taxAmount: bigint;
  notes?: string;
  createdById: string;
  /** Human voucher number; minted from the EXPENSE sequence when omitted. */
  docNo?: string;
  /** Double-submit protection: stored on the row; the route checks it first (migration 0031). */
  idempotencyKey?: string;
  /** Module 3: spawned from a bank statement line. */
  statementLineId?: string;
  /** Module 13: project tag — stamped on every journal line (balance unchanged). */
  projectId?: string | null;
};

export async function postExpense(tx: DbTx, input: PostExpenseInput): Promise<string> {
  if (input.amount <= 0n) throw new UserError("Expense amount must be positive");
  if (input.taxAmount < 0n) throw new UserError("Tax amount cannot be negative");
  const ac = await accountMap(tx, input.companyId);

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new UserError("Bank/cash account not found");

  const glRows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  const gl = glRows[0];
  // Module 3: direct (non-invoiced) payments may hit an Expense OR an Asset
  // account (e.g. buying equipment for cash).
  if (!gl || (gl.type !== "EXPENSE" && gl.type !== "ASSET"))
    throw new UserError("Please select a valid expense or asset account");

  const total = input.amount + input.taxAmount;
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.notes || `Expense — ${gl.name}`,
    source: "EXPENSE",
    createdById: input.createdById,
    lines: withProject(
      [
        { accountId: gl.id, debit: input.amount, credit: 0n },
        ...(input.taxAmount > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxAmount, credit: 0n }] : []),
        { accountId: bank.accountId, debit: 0n, credit: total },
      ],
      input.projectId
    ),
  });

  const expenseId = input.id ?? crypto.randomUUID();
  // Human voucher number (EXP-0001 …). The API route mints it explicitly;
  // other callers (sync push) get one allocated here.
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "EXPENSE"));
  await tx.insert(expenses).values({
    id: expenseId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    accountId: gl.id,
    bankAccountId: bank.id,
    amount: input.amount,
    taxAmount: input.taxAmount,
    notes: input.notes,
    journalEntryId: entryId,
    ...(input.statementLineId ? { statementLineId: input.statementLineId } : {}),
    createdById: input.createdById,
    // Module 13: project tagging (journal lines carry the tag too).
    projectId: input.projectId ?? null,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${total}` })
    .where(eq(bankAccounts.id, bank.id));

  // Module 3: spawned from a bank statement line — link the bank journal line
  // so the statement line shows as explained.
  if (input.statementLineId) {
    const jl = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.accountId, bank.accountId)))
      .limit(1);
    if (!jl[0]) throw new UserError("Could not find the bank journal line.");
    await markStatementLineCreated(
      tx, input.companyId, input.statementLineId, jl[0].id, "EXPENSE", expenseId, input.createdById
    );
  }

  return expenseId;
}

// ─── Sundry receipts (Module 3: direct, non-invoiced receipts) ───

export type PostSundryReceiptInput = {
  /** Optional explicit id (sync push uses the client's refId); defaults to a fresh UUID. */
  id?: string;
  companyId: string;
  branchId: string;
  /** Credited GL account — must be INCOME or ASSET type. */
  accountId: string;
  bankAccountId: string;
  date: Date;
  amount: bigint;
  notes?: string;
  createdById: string;
  /** Human voucher number; minted from the SUNDRY_RECEIPT sequence when omitted. */
  docNo?: string;
  /** Double-submit protection: stored on the row; the route checks it first. */
  idempotencyKey?: string;
  /** Spawned from a bank statement line. */
  statementLineId?: string;
};

/**
 * Direct receipt: Dr Bank / Cr Income-or-Asset (rental income, refunds,
 * misc receipts — nothing invoiced). One journal per document; voids via
 * reversing journal in lib/payment-void.ts.
 */
export async function postSundryReceipt(
  tx: DbTx,
  input: PostSundryReceiptInput
): Promise<{ id: string; docNo: string }> {
  if (input.amount <= 0n) throw new UserError("Receipt amount must be positive");

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new UserError("Bank/cash account not found");

  const glRows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  const gl = glRows[0];
  if (!gl || (gl.type !== "INCOME" && gl.type !== "ASSET"))
    throw new UserError("Please select a valid income or asset account");

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.notes || `Receipt — ${gl.name}`,
    source: FIX3_SOURCES.SUNDRY_RECEIPT,
    createdById: input.createdById,
    lines: [
      { accountId: bank.accountId, debit: input.amount, credit: 0n },
      { accountId: gl.id, debit: 0n, credit: input.amount },
    ],
  });

  const receiptId = input.id ?? crypto.randomUUID();
  const docNo = input.docNo ?? (await nextDocNo(tx, input.companyId, "SUNDRY_RECEIPT"));
  await tx.insert(sundryReceipts).values({
    id: receiptId,
    companyId: input.companyId,
    branchId: input.branchId,
    docNo,
    date: input.date,
    accountId: gl.id,
    bankAccountId: bank.id,
    amount: input.amount,
    notes: input.notes,
    journalEntryId: entryId,
    ...(input.statementLineId ? { statementLineId: input.statementLineId } : {}),
    createdById: input.createdById,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${input.amount}` })
    .where(eq(bankAccounts.id, bank.id));

  // Module 3: spawned from a bank statement line — link the bank journal line
  // so the statement line shows as explained.
  if (input.statementLineId) {
    const jl = await tx
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(and(eq(journalLines.entryId, entryId), eq(journalLines.accountId, bank.accountId)))
      .limit(1);
    if (!jl[0]) throw new UserError("Could not find the bank journal line.");
    await markStatementLineCreated(
      tx, input.companyId, input.statementLineId, jl[0].id, "SUNDRY_RECEIPT", receiptId, input.createdById
    );
  }

  return { id: receiptId, docNo };
}
