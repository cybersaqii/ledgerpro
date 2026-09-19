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
} from "@/db/schema";
import { SYS, accountMap } from "./setup";
import type { DbTx } from "./db";
import type { ComputedItem } from "./totals";

type JournalLineInput = {
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
async function applyStock(
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
      throw new Error(`Insufficient stock for "${p[0]?.name ?? "product"}"`);
    }
    let newAvg = avg;
    if (m.qtyMilli > 0n && m.unitCostPaisa !== undefined) {
      const currentValue = (current * avg) / 1000n;
      const inValue = (m.qtyMilli * m.unitCostPaisa) / 1000n;
      newAvg = next > 0n ? ((currentValue + inValue) * 1000n) / next : avg;
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
  items: (ComputedItem & { trackStock: boolean })[];
  discountTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  createdById: string;
};

export async function postSalesDoc(tx: DbTx, input: PostSalesInput): Promise<string> {
  const ac = await accountMap(tx, input.companyId);
  // Gross sales = sum of line net amounts (after item discounts, before doc discount).
  // The doc discount is booked separately to DISCOUNT_GIVEN so the journal balances
  // and gross sales stay visible in reports.
  const grossSales = input.items.reduce((a, i) => a + i.taxablePaisa, 0n);

  const stockMoves: StockMove[] = input.items
    .filter((i) => i.productId && i.trackStock)
    .map((i) => ({
      productId: i.productId!,
      qtyMilli: input.docType === "INVOICE" ? -i.qtyMilli : i.qtyMilli,
      avgCostPaisa: 0n,
    }));

  for (const m of stockMoves) {
    const rows = await tx
      .select({ avgCost: stockLevels.avgCost })
      .from(stockLevels)
      .where(and(eq(stockLevels.productId, m.productId), eq(stockLevels.branchId, input.branchId)))
      .limit(1);
    m.avgCostPaisa = rows[0]?.avgCost ?? 0n;
  }
  const { cogsOut, cogsIn } = await applyStock(tx, input.branchId, stockMoves);

  const lines: JournalLineInput[] =
    input.docType === "INVOICE"
      ? [
          { accountId: ac[SYS.AR], debit: input.grandTotal, credit: 0n, partyId: input.partyId },
          { accountId: ac[SYS.SALES], debit: 0n, credit: grossSales },
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.TAX_PAYABLE], debit: 0n, credit: input.taxTotal }] : []),
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_GIVEN], debit: input.discountTotal, credit: 0n }] : []),
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

export type PostPurchaseInput = {
  companyId: string;
  branchId: string;
  partyId: string;
  docId: string;
  docNo: string;
  docType: "BILL" | "RETURN";
  date: Date;
  items: (ComputedItem & { trackStock: boolean })[];
  discountTotal: bigint;
  taxTotal: bigint;
  grandTotal: bigint;
  createdById: string;
};

export async function postPurchaseDoc(tx: DbTx, input: PostPurchaseInput): Promise<string> {
  const ac = await accountMap(tx, input.companyId);

  let stockNet = 0n;
  let nonStockNet = 0n;
  const stockMoves: StockMove[] = [];
  for (const i of input.items) {
    const net = i.taxablePaisa;
    if (i.productId && i.trackStock) {
      stockNet += net;
      stockMoves.push({
        productId: i.productId,
        qtyMilli: input.docType === "BILL" ? i.qtyMilli : -i.qtyMilli,
        avgCostPaisa: 0n,
        unitCostPaisa: i.qtyMilli > 0n ? (net * 1000n) / i.qtyMilli : 0n,
      });
    } else {
      nonStockNet += net;
    }
  }
  const { cogsOut: stockCostOut } = await applyStock(tx, input.branchId, stockMoves);
  // For purchase returns, inventory leaves at average cost (stockCostOut), not at
  // the return document's rate. Any difference is a price gain/loss vs cost.
  const priceDiff = stockNet - stockCostOut;

  const lines: JournalLineInput[] =
    input.docType === "BILL"
      ? [
          ...(stockNet > 0n ? [{ accountId: ac[SYS.INVENTORY], debit: stockNet, credit: 0n }] : []),
          ...(nonStockNet > 0n ? [{ accountId: ac[SYS.PURCHASES], debit: nonStockNet, credit: 0n }] : []),
          ...(input.taxTotal > 0n ? [{ accountId: ac[SYS.INPUT_TAX], debit: input.taxTotal, credit: 0n }] : []),
          { accountId: ac[SYS.AP], debit: 0n, credit: input.grandTotal, partyId: input.partyId },
          ...(input.discountTotal > 0n ? [{ accountId: ac[SYS.DISCOUNT_RECEIVED], debit: 0n, credit: input.discountTotal }] : []),
        ]
      : [
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
        ];

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: input.docType === "BILL" ? `Purchase bill ${input.docNo}` : `Purchase return ${input.docNo}`,
    reference: input.docNo,
    source: "PURCHASE",
    sourceId: input.docId,
    createdById: input.createdById,
    lines,
  });

  await bumpPartyBalance(tx, input.partyId, input.docType === "BILL" ? input.grandTotal : -input.grandTotal);
  return entryId;
}

// ─── Payments ──────────────────────────────────────────────────

export type AllocationInput = { docId: string; docKind: "SALES" | "PURCHASE"; amount: bigint };

export type PostPaymentInput = {
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
  allocations: AllocationInput[];
  createdById: string;
};

export async function postPayment(tx: DbTx, input: PostPaymentInput): Promise<string> {
  if (input.amount <= 0n) throw new Error("Payment amount must be positive");
  const ac = await accountMap(tx, input.companyId);

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new Error("Bank/cash account not found");

  const allocTotal = input.allocations.reduce((a, x) => a + x.amount, 0n);
  if (allocTotal > input.amount) throw new Error("Allocated amount exceeds payment amount");
  for (const a of input.allocations) {
    if (a.amount <= 0n) throw new Error("Allocation amounts must be positive");
  }

  const isReceipt = input.kind === "RECEIPT";
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `${isReceipt ? "Receipt" : "Payment"}${input.reference ? ` ${input.reference}` : ""}`,
    reference: input.reference,
    source: "PAYMENT",
    createdById: input.createdById,
    lines: isReceipt
      ? [
          { accountId: bank.accountId, debit: input.amount, credit: 0n },
          { accountId: ac[SYS.AR], debit: 0n, credit: input.amount, partyId: input.partyId },
        ]
      : [
          { accountId: ac[SYS.AP], debit: input.amount, credit: 0n, partyId: input.partyId },
          { accountId: bank.accountId, debit: 0n, credit: input.amount },
        ],
  });

  const paymentId = crypto.randomUUID();
  await tx.insert(payments).values({
    id: paymentId,
    companyId: input.companyId,
    branchId: input.branchId,
    kind: input.kind,
    date: input.date,
    partyId: input.partyId,
    bankAccountId: input.bankAccountId,
    amount: input.amount,
    method: input.method,
    reference: input.reference,
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
  });

  for (const a of input.allocations) {
    if (a.docKind === "SALES") {
      const rows = await tx
        .select()
        .from(salesDocs)
        .where(and(eq(salesDocs.id, a.docId), eq(salesDocs.companyId, input.companyId)))
        .limit(1);
      const doc = rows[0];
      if (!doc || doc.partyId !== input.partyId) throw new Error("Invalid sales document for allocation");
      const remaining = doc.grandTotal - doc.amountPaid;
      if (a.amount > remaining) throw new Error(`Allocation exceeds remaining balance of ${doc.docNo}`);
      const paid = doc.amountPaid + a.amount;
      await tx
        .update(salesDocs)
        .set({ amountPaid: paid, status: paid >= doc.grandTotal ? "PAID" : "PARTIAL", updatedAt: new Date() })
        .where(eq(salesDocs.id, doc.id));
      await tx.insert(paymentAllocations).values({
        id: crypto.randomUUID(),
        paymentId,
        partyId: input.partyId,
        salesDocId: doc.id,
        amount: a.amount,
      });
    } else {
      const rows = await tx
        .select()
        .from(purchaseDocs)
        .where(and(eq(purchaseDocs.id, a.docId), eq(purchaseDocs.companyId, input.companyId)))
        .limit(1);
      const doc = rows[0];
      if (!doc || doc.partyId !== input.partyId) throw new Error("Invalid purchase document for allocation");
      const remaining = doc.grandTotal - doc.amountPaid;
      if (a.amount > remaining) throw new Error(`Allocation exceeds remaining balance of ${doc.docNo}`);
      const paid = doc.amountPaid + a.amount;
      await tx
        .update(purchaseDocs)
        .set({ amountPaid: paid, status: paid >= doc.grandTotal ? "PAID" : "PARTIAL", updatedAt: new Date() })
        .where(eq(purchaseDocs.id, doc.id));
      await tx.insert(paymentAllocations).values({
        id: crypto.randomUUID(),
        paymentId,
        partyId: input.partyId,
        purchaseDocId: doc.id,
        amount: a.amount,
      });
    }
  }

  await bumpPartyBalance(tx, input.partyId, -input.amount);
  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} + ${isReceipt ? input.amount : -input.amount}` })
    .where(eq(bankAccounts.id, bank.id));

  return paymentId;
}

// ─── Expenses ──────────────────────────────────────────────────

export type PostExpenseInput = {
  companyId: string;
  branchId: string;
  accountId: string;
  bankAccountId: string;
  date: Date;
  amount: bigint;
  taxAmount: bigint;
  notes?: string;
  createdById: string;
};

export async function postExpense(tx: DbTx, input: PostExpenseInput): Promise<string> {
  if (input.amount <= 0n) throw new Error("Expense amount must be positive");
  if (input.taxAmount < 0n) throw new Error("Tax amount cannot be negative");
  const ac = await accountMap(tx, input.companyId);

  const bankRows = await tx
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, input.bankAccountId), eq(bankAccounts.companyId, input.companyId)))
    .limit(1);
  const bank = bankRows[0];
  if (!bank) throw new Error("Bank/cash account not found");

  const glRows = await tx
    .select()
    .from(accounts)
    .where(and(eq(accounts.id, input.accountId), eq(accounts.companyId, input.companyId)))
    .limit(1);
  const gl = glRows[0];
  if (!gl || gl.type !== "EXPENSE") throw new Error("Please select a valid expense account");

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

  const expenseId = crypto.randomUUID();
  await tx.insert(expenses).values({
    id: expenseId,
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    accountId: gl.id,
    bankAccountId: bank.id,
    amount: input.amount,
    taxAmount: input.taxAmount,
    notes: input.notes,
    journalEntryId: entryId,
    createdById: input.createdById,
  });

  await tx
    .update(bankAccounts)
    .set({ balance: sql`${bankAccounts.balance} - ${total}` })
    .where(eq(bankAccounts.id, bank.id));

  return expenseId;
}
