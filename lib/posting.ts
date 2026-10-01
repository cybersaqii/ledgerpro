import { eq, and, sql } from "drizzle-orm";
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
import type { DbTx } from "./db";
import type { ComputedItem } from "./totals";
import { UserError } from "./errors";
import { FIX3_SOURCES } from "./stock-adjust";
import { markStatementLineCreated } from "./statements";
import { explodeSalesStockMoves } from "./bundles";
import { addBatchStock, deductBatchStock, restoreBatchStock, restoreLineageBatches, deductLineageBatches, recordBatchUsage } from "./batches";

export type JournalLineInput = {
  accountId: string;
  debit: bigint;
  credit: bigint;
  partyId?: string | null;
  memo?: string;
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
    }))
  );
  return entryId;
}

export type StockMove = {
  productId: string;
  qtyMilli: bigint; // positive = stock in, negative = stock out
  avgCostPaisa: bigint;
  unitCostPaisa?: bigint; // for stock in: purchase rate per unit
};

/** Apply stock moves inside the transaction. Throws on insufficient stock.
 *  Returns the value moved at average cost, split into out (sales/usage) and
 *  in (returns) so callers can book matching COGS entries. */
export async function applyStock(
  tx: DbTx,
  branchId: string,
  moves: StockMove[]
): Promise<{ cogsOut: bigint; cogsIn: bigint }> {
  let cogsOut = 0n;
  let cogsIn = 0n;
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
    if (m.qtyMilli < 0n) {
      cogsOut += ((-m.qtyMilli * avg + 500n) / 1000n); // half-up
    } else if (m.qtyMilli > 0n) {
      cogsIn += ((m.qtyMilli * avg + 500n) / 1000n); // value restored at avg cost
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
  }
  return { cogsOut, cogsIn };
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
  items: (ComputedItem & { trackStock: boolean; batchId?: string | null })[];
  discountTotal: bigint;
  taxTotal: bigint;
  /** Sales-side freight charged to the customer (untaxed) → Freight Income 4020. */
  freightTotal?: bigint;
  grandTotal: bigint;
  createdById: string;
  /** RETURN docs: the source INVOICE id, used to restore its exact batches. */
  sourceDocId?: string;
};

export async function postSalesDoc(tx: DbTx, input: PostSalesInput): Promise<string> {
  const ac = await accountMap(tx, input.companyId);
  // Gross sales = sum of line net amounts (after item discounts, before doc discount).
  // The doc discount is booked separately to DISCOUNT_GIVEN so the journal balances
  // and gross sales stay visible in reports.
  const grossSales = input.items.reduce((a, i) => a + i.taxablePaisa, 0n);

  // Bundle lines explode into their components for stock + COGS; the bundle
  // product itself never gets a stock movement. Plain lines pass through.
  // Insufficient component stock throws here, rolling back the whole doc.
  // Each exploded move carries the line's batch choice (plain lines only —
  // bundle explosion drops it, components use FIFO).
  const stockMoves = (
    await explodeSalesStockMoves(
      tx,
      input.companyId,
      input.items.map((i) => ({
        productId: i.productId,
        qtyMilli: i.qtyMilli,
        trackStock: i.trackStock,
        batchId: i.batchId ?? null,
      })),
      input.docType
    )
  ).map((m) => ({ productId: m.productId, qtyMilli: m.qtyMilli, avgCostPaisa: 0n, batchId: m.batchId }));

  for (const m of stockMoves) {
    const rows = await tx
      .select({ avgCost: stockLevels.avgCost })
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, m.productId), eq(stockLevels.branchId, input.branchId)))
      .limit(1);
    m.avgCostPaisa = rows[0]?.avgCost ?? 0n;
  }

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

  const { cogsOut, cogsIn } = await applyStock(tx, input.branchId, stockMoves);

  const lines: JournalLineInput[] =
    input.docType === "INVOICE"
      ? [
          { accountId: ac[SYS.AR], debit: input.grandTotal, credit: 0n, partyId: input.partyId },
          { accountId: ac[SYS.SALES], debit: 0n, credit: grossSales },
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: input.taxTotal }] : []),
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_GIVEN], debit: input.discountTotal, credit: 0n }] : []),
          // Freight charged to the customer is income (SYS 4020), never part
          // of sales revenue. AR already carries grandTotal (freight
          // included), so this line only reclassifies the freight slice.
          ...((input.freightTotal ?? 0n) > 0n
            ? [{ accountId: ac[SYS.FREIGHT_INCOME], debit: 0n, credit: input.freightTotal ?? 0n }]
            : []),
          ...(cogsOut > 0n
            ? [
                { accountId: ac[SYS.COGS], debit: cogsOut, credit: 0n },
                { accountId: ac[SYS.INVENTORY], debit: 0n, credit: cogsOut },
              ]
            : []),
        ]
      : [
          { accountId: ac[SYS.SALES_RETURN], debit: grossSales, credit: 0n },
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: input.taxTotal, credit: 0n }] : []),
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_GIVEN], debit: 0n, credit: input.discountTotal }] : []),
          { accountId: ac[SYS.AR], debit: 0n, credit: input.grandTotal, partyId: input.partyId },
          ...(cogsIn > 0n
            ? [
                { accountId: ac[SYS.INVENTORY], debit: cogsIn, credit: 0n },
                { accountId: ac[SYS.COGS], debit: 0n, credit: cogsIn },
              ]
            : []),
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
    lines,
  });

  await bumpPartyBalance(tx, input.partyId, input.docType === "INVOICE" ? input.grandTotal : -input.grandTotal);
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
  })[];
  discountTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  createdById: string;
  /** Landed extra costs (freight, labour): distributed into stock unit cost. */
  extraCosts?: ExtraCostInput[];
  /** How the extra costs were paid: cash/bank account, or added to the supplier bill. */
  extraCostPaidFrom?: "CASH" | "SUPPLIER";
  extraCostAccountId?: string;
  /** RETURN docs: the source BILL id, used to deduct from its exact batches. */
  sourceDocId?: string;
  /** BILL: withholding-tax deducted on this bill (Cr WHT Payable 2100; reduces the AP credit). */
  whtAmount?: bigint;
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
  const stockMoves: StockMove[] = [];
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

  const { cogsOut: stockCostOut } = await applyStock(tx, input.branchId, stockMoves);
  // For purchase returns, inventory leaves at average cost (stockCostOut), not at
  // the return document's rate. Any difference is a price gain/loss vs cost.
  const priceDiff = stockNet - stockCostOut;

  // GRN-sourced bills move no stock, but landed extra costs still lift the
  // received stock's unit cost (the GRN already holds the quantities).
  if (fromGrn && totalExtra > 0n) {
    for (const idx of stockItemIdx) {
      const i = input.items[idx]!;
      const share = landedByItem.get(idx) ?? 0n;
      if (share > 0n && i.productId) await adjustStockCost(tx, input.branchId, i.productId, share);
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
        ...(totalExtra > 0n ? [{ accountId: ac[SYS.INVENTORY], debit: totalExtra, credit: 0n }] : []),
        ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxTotal, credit: 0n }] : []),
        ...(whtAmount > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: whtAmount, partyId: input.partyId }] : []),
        { accountId: ac[SYS.AP], debit: 0n, credit: input.grandTotal - whtAmount, partyId: input.partyId },
        ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: 0n, credit: input.discountTotal }] : []),
        ...(extraCredit ? [extraCredit] : []),
      ]
    : [
        ...((stockNet + totalExtra) > 0n ? [{ accountId: ac[SYS.INVENTORY], debit: stockNet + totalExtra, credit: 0n }] : []),
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
        ...(stockCostOut > 0n ? [{ accountId: ac[SYS.INVENTORY], debit: 0n, credit: stockCostOut }] : []),
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
    lines,
  });

  // The AP credit is net of WHT (the withheld tax is owed to the tax
  // authority, not the supplier), so the party balance moves by the net too.
  const apNet = input.grandTotal - whtAmount;
  await bumpPartyBalance(tx, input.partyId, input.docType === "BILL" ? apNet : -input.grandTotal);
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
  /** Double-submit protection: stored on the row; the route checks it first (migration 0031). */
  idempotencyKey?: string;
};

/** Allocate part of a payment to one document: bumps amountPaid, flips
 *  POSTED/PARTIAL → PARTIAL/PAID, and writes the payment_allocations row.
 *  Shared by postPayment and PDC auto-allocation on clear. */
export async function allocatePaymentToDoc(
  tx: DbTx,
  opts: {
    companyId: string;
    paymentId: string;
    partyId: string;
    docKind: "SALES" | "PURCHASE";
    docId: string;
    amount: bigint;
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
    const remaining = doc.grandTotal - doc.amountPaid - doc.returnedTotal;
    if (opts.amount > remaining) throw new UserError(`Allocation exceeds remaining balance of ${doc.docNo}`);
    const paid = doc.amountPaid + opts.amount;
    const netTotal = doc.grandTotal - doc.returnedTotal;
    await tx
      .update(salesDocs)
      .set({ amountPaid: paid, status: paid >= netTotal ? "PAID" : "PARTIAL", updatedAt: new Date() })
      .where(eq(salesDocs.id, doc.id));
    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: opts.paymentId,
      partyId: opts.partyId,
      salesDocId: doc.id,
      amount: opts.amount,
    });
  } else {
    const rows = await tx
      .select()
      .from(purchaseDocs)
      .where(and(eq(purchaseDocs.id, opts.docId), eq(purchaseDocs.companyId, opts.companyId)))
      .limit(1);
    const doc = rows[0];
    if (!doc || doc.partyId !== opts.partyId) throw new UserError("Invalid purchase document for allocation");
    const remaining = doc.grandTotal - doc.amountPaid - doc.returnedTotal;
    if (opts.amount > remaining) throw new UserError(`Allocation exceeds remaining balance of ${doc.docNo}`);
    const paid = doc.amountPaid + opts.amount;
    const netTotal = doc.grandTotal - doc.returnedTotal;
    await tx
      .update(purchaseDocs)
      .set({ amountPaid: paid, status: paid >= netTotal ? "PAID" : "PARTIAL", updatedAt: new Date() })
      .where(eq(purchaseDocs.id, doc.id));
    await tx.insert(paymentAllocations).values({
      id: crypto.randomUUID(),
      paymentId: opts.paymentId,
      partyId: opts.partyId,
      purchaseDocId: doc.id,
      amount: opts.amount,
    });
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
    lines: isReceipt
      ? [
          { accountId: bank.accountId, debit: input.amount, credit: 0n },
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
            { accountId: bank.accountId, debit: 0n, credit: input.amount },
          ]
        : [
            { accountId: arApAccount, debit: input.amount, credit: 0n, partyId: input.partyId },
            { accountId: bank.accountId, debit: 0n, credit: input.amount },
          ],
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
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });

  for (const a of input.allocations) {
    await allocatePaymentToDoc(tx, {
      companyId: input.companyId,
      paymentId,
      partyId: input.partyId,
      docKind: a.docKind,
      docId: a.docId,
      amount: a.amount,
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
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${isReceipt ? input.amount : -input.amount}` })
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
    lines: [
      { accountId: gl.id, debit: input.amount, credit: 0n },
      ...(input.taxAmount > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxAmount, credit: 0n }] : []),
      { accountId: bank.accountId, debit: 0n, credit: total },
    ],
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
