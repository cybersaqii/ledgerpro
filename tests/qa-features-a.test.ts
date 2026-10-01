/**
 * FIX-3 money features — G1 stock adjustments, G2 bank↔cash transfers,
 * G4 payment void + unallocate, G7 bad-debt write-off, G8 expense void.
 *
 * Proves, per feature: balanced journals, correct balance changes (stock
 * qty/value, bank balances, party balances, doc amountPaid/status),
 * period-lock enforcement, voided-marker behavior, the advance-consumption
 * void block, unallocate freeing credit without touching the journal, the
 * write-off + recover round-trip, and ADJ-/TRF-/WO- doc numbering (the
 * number_sequences rows are seeded directly in setup, mirroring migration
 * 0027's seeds for existing companies).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, addBankAccount, accountMap, SYS } from "@/lib/setup";
import { postPayment, postExpense } from "@/lib/posting";
import { parseMoney } from "@/lib/money";
import { postStockAdjustment } from "@/lib/stock-adjust";
import { postTransfer } from "@/lib/transfers";
import { voidPayment, unallocatePaymentRow, voidExpense } from "@/lib/payment-void";
import { postWriteOff, recoverWriteOff } from "@/lib/writeoff";
import { writeOffs, stockAdjustments, transfers } from "@/db/schema";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let customerId = "";
let productId = "";
let zeroCostProductId = "";
let cashId = "";
let bankId = "";
let cashGlId = "";
let bankGlId = "";
let expenseAcctId = "";
let gainAcctId = "";
let inventoryAcctId = "";
let arAcctId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  ({ branchId } = await setupCompany(db, companyId));
  // setupCompany seeds branches/accounts/sequences only — the company row
  // itself (which carries the period lock) must exist explicitly.
  await db.insert(s.companies).values({ id: companyId, name: "FIX-3 Test Co" });

  // setupCompany seeds every DOC_PREFIXES sequence (incl. WRITE_OFF/WO-,
  // TRANSFER/TRF- and STOCK_ADJUSTMENT/ADJ-), so no manual seeding is needed.
  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  zeroCostProductId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: customerId, companyId, kind: "CUSTOMER", name: "WO Customer" });
  await db.insert(s.products).values([
    {
      id: productId, companyId, sku: "ADJ-ITEM", name: "Adjustable Item", unit: "PCS",
      purchasePrice: parseMoney("80"), salePrice: parseMoney("100"),
    },
    {
      id: zeroCostProductId, companyId, sku: "ZERO-ITEM", name: "Zero Cost Item", unit: "PCS",
      purchasePrice: 0n, salePrice: parseMoney("50"),
    },
  ]);
  // 10 units @ Rs 100 average cost.
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId, branchId, qty: 10_000n, avgCost: parseMoney("100"),
  });

  const cash = await db
    .select()
    .from(s.bankAccounts)
    .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
    .limit(1);
  cashId = cash[0]!.id;
  cashGlId = cash[0]!.accountId;
  const bank = await addBankAccount(db, companyId, { name: "Test Bank", kind: "BANK" });
  bankId = bank.id;
  bankGlId = bank.accountId;

  const ac = await db.transaction((tx) => accountMap(tx, companyId));
  expenseAcctId = ac[SYS.EXPENSES]!;
  gainAcctId = ac[SYS.ADJUSTMENT_GAIN]!;
  inventoryAcctId = ac[SYS.INVENTORY]!;
  arAcctId = ac[SYS.AR]!;
});

afterAll(() => cleanup());

// ─── helpers ────────────────────────────────────────────────────

async function bankBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.bankAccounts.balance }).from(s.bankAccounts).where(eq(s.bankAccounts.id, id)).limit(1);
  return r[0]!.b;
}
async function partyBalance(id: string): Promise<bigint> {
  const r = await db.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, id)).limit(1);
  return r[0]!.b;
}
async function stockOf(pid: string): Promise<{ qty: bigint; avgCost: bigint }> {
  const r = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, pid), eq(s.stockLevels.branchId, branchId)))
    .limit(1);
  return { qty: r[0]?.qty ?? 0n, avgCost: r[0]?.avgCost ?? 0n };
}
/** Journal lines for one entry: [{accountId, debit, credit, partyId}]. */
async function entryLines(entryId: string) {
  return db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
}
async function entryBySource(source: string, sourceId: string) {
  const r = await db
    .select()
    .from(s.journalEntries)
    .where(and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, source), eq(s.journalEntries.sourceId, sourceId)))
    .limit(1);
  return r[0];
}
function expectEntryBalanced(lines: { debit: bigint; credit: bigint }[]) {
  const d = lines.reduce((a, l) => a + l.debit, 0n);
  const c = lines.reduce((a, l) => a + l.credit, 0n);
  expect(d).toBe(c);
  expect(d).toBeGreaterThan(0n);
}
async function lockPeriod(until: Date | null) {
  await db.update(s.companies).set({ lockedUntil: until }).where(eq(s.companies.id, companyId));
}
async function mkInvoice(party: string, docNo: string, grand: bigint): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.salesDocs).values({
    id, companyId, branchId, partyId: party, docType: "INVOICE", docNo,
    date: new Date(), status: "POSTED", subtotal: grand, discountTotal: 0n,
    taxTotal: 0n, grandTotal: grand, amountPaid: 0n, returnedTotal: 0n,
    createdById: userId,
  });
  return id;
}
async function docState(id: string) {
  const r = (await db.run(
    sql`SELECT amount_paid AS p, status AS st, COALESCE(written_off_amount, 0) AS w FROM sales_docs WHERE id = ${id}`
  )).rows[0] as unknown as { p: number; st: string; w: number };
  return { amountPaid: BigInt(r.p), status: r.st, writtenOff: BigInt(r.w) };
}
async function paymentVoidedAt(id: string): Promise<number | null> {
  const r = (await db.run(sql`SELECT voided_at AS v FROM payments WHERE id = ${id}`)).rows[0] as
    unknown as { v: number | null } | undefined;
  return r?.v ?? null;
}
async function expenseVoidedAt(id: string): Promise<number | null> {
  const r = (await db.run(sql`SELECT voided_at AS v FROM expenses WHERE id = ${id}`)).rows[0] as
    unknown as { v: number | null } | undefined;
  return r?.v ?? null;
}

// ─── G1 stock adjustments ───────────────────────────────────────

describe("G1 stock adjustment", () => {
  it("posts a balanced BREAKAGE journal and reduces stock qty + value", async () => {
    const before = await stockOf(productId);
    const r = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId, reason: "BREAKAGE", accountId: expenseAcctId,
        date: new Date(), lines: [{ productId, qtyMilli: -2_000n }],
        notes: "breakage test", createdById: userId,
      })
    );
    expect(r.docNo).toBe("ADJ-0001");

    const after = await stockOf(productId);
    expect(after.qty).toBe(before.qty - 2_000n);

    const entry = await entryBySource("STOCK_ADJUSTMENT", r.id);
    expect(entry).toBeDefined();
    const lines = await entryLines(entry!.id);
    expectEntryBalanced(lines);
    // 2 units @ Rs 100 => Rs 200 loss: Dr expense / Cr inventory.
    const loss = 2n * parseMoney("100");
    expect(lines).toHaveLength(2);
    expect(lines.find((l) => l.accountId === expenseAcctId)).toMatchObject({ debit: loss, credit: 0n });
    expect(lines.find((l) => l.accountId === inventoryAcctId)).toMatchObject({ debit: 0n, credit: loss });

    const hdr = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, r.id)).limit(1);
    expect(hdr[0]!.journalEntryId).toBe(entry!.id);
  });

  it("posts the reverse journal for FOUND and adds stock", async () => {
    const before = await stockOf(productId);
    const r = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId, reason: "FOUND",
        date: new Date(), lines: [{ productId, qtyMilli: 1_000n }],
        createdById: userId,
      })
    );
    expect(r.docNo).toBe("ADJ-0002");
    expect((await stockOf(productId)).qty).toBe(before.qty + 1_000n);

    const entry = await entryBySource("STOCK_ADJUSTMENT", r.id);
    const lines = await entryLines(entry!.id);
    expectEntryBalanced(lines);
    const gain = parseMoney("100");
    expect(lines.find((l) => l.accountId === inventoryAcctId)).toMatchObject({ debit: gain, credit: 0n });
    expect(lines.find((l) => l.accountId === gainAcctId)).toMatchObject({ debit: 0n, credit: gain });
  });

  it("rejects wrong-direction quantities for loss reasons", async () => {
    await expect(
      db.transaction((tx) =>
        postStockAdjustment(tx, {
          companyId, branchId, reason: "THEFT", accountId: expenseAcctId,
          date: new Date(), lines: [{ productId, qtyMilli: 1_000n }],
          createdById: userId,
        })
      )
    ).rejects.toThrow(/only removes stock/);
    await expect(
      db.transaction((tx) =>
        postStockAdjustment(tx, {
          companyId, branchId, reason: "FOUND", accountId: expenseAcctId,
          date: new Date(), lines: [{ productId, qtyMilli: -1_000n }],
          createdById: userId,
        })
      )
    ).rejects.toThrow(/only adds stock/);
  });

  it("rejects adjustments beyond available stock", async () => {
    await expect(
      db.transaction((tx) =>
        postStockAdjustment(tx, {
          companyId, branchId, reason: "BREAKAGE", accountId: expenseAcctId,
          date: new Date(), lines: [{ productId, qtyMilli: -1_000_000n }],
          createdById: userId,
        })
      )
    ).rejects.toThrow(/Insufficient stock/);
  });

  it("adjusts quantity with no journal for a zero-value move", async () => {
    const r = await db.transaction((tx) =>
      postStockAdjustment(tx, {
        companyId, branchId, reason: "FOUND",
        date: new Date(), lines: [{ productId: zeroCostProductId, qtyMilli: 5_000n }],
        createdById: userId,
      })
    );
    expect(r.docNo).toBe("ADJ-0003");
    // Zero average cost => no money moved, but the quantity lands in stock.
    expect((await stockOf(zeroCostProductId)).qty).toBe(5_000n);
    const hdr = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, r.id)).limit(1);
    expect(hdr[0]!.journalEntryId).toBeNull();
  });

  it("is blocked in a locked period", async () => {
    await lockPeriod(new Date("2099-01-01T00:00:00Z"));
    try {
      await expect(
        db.transaction((tx) =>
          postStockAdjustment(tx, {
            companyId, branchId, reason: "BREAKAGE", accountId: expenseAcctId,
            date: new Date(), lines: [{ productId, qtyMilli: -100n }],
            createdById: userId,
          })
        )
      ).rejects.toThrow(/locked/i);
    } finally {
      await lockPeriod(null);
    }
  });
});

// ─── G2 bank↔cash transfers ─────────────────────────────────────

describe("G2 bank↔cash transfer", () => {
  it("moves money with a balanced journal and updates both balances", async () => {
    const cashBefore = await bankBalance(cashId);
    const bankBefore = await bankBalance(bankId);
    const amt = parseMoney("1000");
    const r = await db.transaction((tx) =>
      postTransfer(tx, {
        companyId, branchId, fromBankAccountId: cashId, toBankAccountId: bankId,
        date: new Date(), amount: amt, notes: "cash deposit", createdById: userId,
      })
    );
    expect(r.docNo).toBe("TRF-0001");
    expect(await bankBalance(cashId)).toBe(cashBefore - amt);
    expect(await bankBalance(bankId)).toBe(bankBefore + amt);

    const entry = await entryBySource("TRANSFER", r.id);
    const lines = await entryLines(entry!.id);
    expectEntryBalanced(lines);
    // Dr receiving GL / Cr sending GL.
    expect(lines.find((l) => l.accountId === bankGlId)).toMatchObject({ debit: amt, credit: 0n });
    expect(lines.find((l) => l.accountId === cashGlId)).toMatchObject({ debit: 0n, credit: amt });

    const hdr = await db.select().from(transfers).where(eq(transfers.id, r.id)).limit(1);
    expect(hdr[0]!.docNo).toBe("TRF-0001");
    expect(hdr[0]!.journalEntryId).toBe(entry!.id);
  });

  it("numbers transfers sequentially from the seeded TRF- sequence", async () => {
    const r = await db.transaction((tx) =>
      postTransfer(tx, {
        companyId, branchId, fromBankAccountId: bankId, toBankAccountId: cashId,
        date: new Date(), amount: parseMoney("10"), createdById: userId,
      })
    );
    expect(r.docNo).toBe("TRF-0002");
  });

  it("rejects same-account transfers", async () => {
    await expect(
      db.transaction((tx) =>
        postTransfer(tx, {
          companyId, branchId, fromBankAccountId: cashId, toBankAccountId: cashId,
          date: new Date(), amount: parseMoney("10"), createdById: userId,
        })
      )
    ).rejects.toThrow(/different/);
  });

  it("is blocked in a locked period", async () => {
    await lockPeriod(new Date("2099-01-01T00:00:00Z"));
    try {
      await expect(
        db.transaction((tx) =>
          postTransfer(tx, {
            companyId, branchId, fromBankAccountId: cashId, toBankAccountId: bankId,
            date: new Date(), amount: parseMoney("10"), createdById: userId,
          })
        )
      ).rejects.toThrow(/locked/i);
    } finally {
      await lockPeriod(null);
    }
  });
});

// ─── G4 payment void + unallocate ───────────────────────────────

describe("G4 payment void + unallocate", () => {
  it("voids a fully-allocated receipt: allocations released, balances and journals restored", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Void Customer" });
    const inv = await mkInvoice(party, "INV-VOID-1", parseMoney("500"));
    const cashBefore = await bankBalance(cashId);

    const p = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: party, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("500"), method: "CASH",
        allocations: [{ docId: inv, docKind: "SALES", amount: parseMoney("500") }],
        createdById: userId,
      })
    );
    expect((await docState(inv)).status).toBe("PAID");
    expect(await partyBalance(party)).toBe(-parseMoney("500"));

    const v = await db.transaction((tx) => voidPayment(tx, { companyId, paymentId: p.id, reason: "entered twice", userId }));

    // Allocation released and doc status recomputed PAID -> UNPAID.
    const allocs = await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, p.id));
    expect(allocs).toHaveLength(0);
    const st = await docState(inv);
    expect(st.amountPaid).toBe(0n);
    expect(st.status).toBe("UNPAID");
    // Party + bank balances restored.
    expect(await partyBalance(party)).toBe(0n);
    expect(await bankBalance(cashId)).toBe(cashBefore);
    // Reversing journal nets the original entry to zero per account.
    const payRow0 = (await db.select({ je: s.payments.journalEntryId }).from(s.payments).where(eq(s.payments.id, p.id)).limit(1))[0]!;
    const origLines = await entryLines(payRow0.je!);
    const voidEntry = await entryBySource("PAYMENT_VOID", p.id);
    expect(voidEntry!.id).toBe(v.voidJournalEntryId);
    const voidLines = await entryLines(voidEntry!.id);
    const net = new Map<string, bigint>();
    for (const l of [...origLines, ...voidLines]) {
      net.set(l.accountId, (net.get(l.accountId) ?? 0n) + l.debit - l.credit);
    }
    for (const n of net.values()) expect(n).toBe(0n);
    expectEntryBalanced(voidLines);
    // Voided marker stamped.
    expect(await paymentVoidedAt(p.id)).not.toBeNull();

    // Double void is blocked.
    await expect(
      db.transaction((tx) => voidPayment(tx, { companyId, paymentId: p.id, userId }))
    ).rejects.toThrow(/already voided/);
  });

  it("blocks void when the payment's credit was consumed later, naming the doc", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Advance Customer" });
    const adv = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: party, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("200"), method: "CASH",
        allocations: [], createdById: userId,
      })
    );
    // Age the payment so a later allocation row falls outside the grace window.
    await db.run(sql`UPDATE payments SET created_at = ${Date.now() - 600_000} WHERE id = ${adv.id}`);
    const late = await mkInvoice(party, "INV-VOID-LATE", parseMoney("200"));
    await db.insert(s.paymentAllocations).values({
      id: crypto.randomUUID(), paymentId: adv.id, partyId: party,
      salesDocId: late, amount: parseMoney("200"),
    });
    await db.run(sql`UPDATE sales_docs SET amount_paid = ${parseMoney("200")}, status = 'PAID' WHERE id = ${late}`);

    await expect(
      db.transaction((tx) => voidPayment(tx, { companyId, paymentId: adv.id, userId }))
    ).rejects.toThrow(/INV-VOID-LATE/);
  });

  it("unallocate frees credit without touching the journal", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Unalloc Customer" });
    const inv = await mkInvoice(party, "INV-UNALLOC-1", parseMoney("300"));
    const p = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: party, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("300"), method: "CASH",
        allocations: [{ docId: inv, docKind: "SALES", amount: parseMoney("300") }],
        createdById: userId,
      })
    );
    const allocRow = (await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, p.id)))[0]!;
    const payRow = (await db.select().from(s.payments).where(eq(s.payments.id, p.id)).limit(1))[0]!;
    const journalBefore = await entryLines(payRow.journalEntryId!);

    const u = await db.transaction((tx) =>
      unallocatePaymentRow(tx, { companyId, allocationId: allocRow.id, userId })
    );
    expect(u.freedAmount).toBe(parseMoney("300"));

    // Credit freed: doc back to UNPAID, allocation row gone.
    const st = await docState(inv);
    expect(st.amountPaid).toBe(0n);
    expect(st.status).toBe("UNPAID");
    expect(await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, p.id))).toHaveLength(0);
    // Journal untouched, payment not voided.
    const journalAfter = await entryLines(payRow.journalEntryId!);
    expect(journalAfter.map((l) => [l.accountId, l.debit, l.credit])).toEqual(
      journalBefore.map((l) => [l.accountId, l.debit, l.credit])
    );
    expect(await paymentVoidedAt(p.id)).toBeNull();
  });

  it("blocks void in a locked period (original date or void date)", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Locked Customer" });
    const p = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: party, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("50"), method: "CASH",
        allocations: [], createdById: userId,
      })
    );
    await lockPeriod(new Date("2099-01-01T00:00:00Z"));
    try {
      await expect(
        db.transaction((tx) => voidPayment(tx, { companyId, paymentId: p.id, userId }))
      ).rejects.toThrow(/locked/i);
    } finally {
      await lockPeriod(null);
    }
  });
});

// ─── G7 bad-debt write-off ──────────────────────────────────────

describe("G7 bad-debt write-off", () => {
  it("writes off part of an invoice: Dr bad debts / Cr AR, party balance down, aging nets it off", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Bad Debt Customer" });
    const inv = await mkInvoice(party, "INV-WO-1", parseMoney("500"));

    const wo = await db.transaction((tx) =>
      postWriteOff(tx, {
        companyId, branchId, partyId: party, salesDocId: inv, accountId: expenseAcctId,
        date: new Date(), amount: parseMoney("200"), notes: "customer vanished", createdById: userId,
      })
    );
    // Numbered from the seeded WRITE_OFF sequence (numeric suffix increments).
    expect(wo.docNo).toMatch(/0001$/);

    const entry = await entryBySource("WRITE_OFF", wo.id);
    const lines = await entryLines(entry!.id);
    expectEntryBalanced(lines);
    expect(lines.find((l) => l.accountId === expenseAcctId)).toMatchObject({ debit: parseMoney("200"), credit: 0n });
    const arLine = lines.find((l) => l.accountId === arAcctId)!;
    expect(arLine).toMatchObject({ debit: 0n, credit: parseMoney("200") });
    expect(arLine.partyId).toBe(party);

    // Collectible balance reduced; aging nets written_off_amount off.
    const st = await docState(inv);
    expect(st.writtenOff).toBe(parseMoney("200"));
    const agingOutstanding = (await db.run(
      sql`SELECT grand_total - amount_paid - COALESCE(written_off_amount, 0) AS o FROM sales_docs WHERE id = ${inv}`
    )).rows[0] as unknown as { o: number };
    expect(BigInt(agingOutstanding.o)).toBe(parseMoney("300"));
    expect(await partyBalance(party)).toBe(-parseMoney("200"));

    const hdr = await db.select().from(writeOffs).where(eq(writeOffs.id, wo.id)).limit(1);
    expect(hdr[0]!.journalEntryId).toBe(entry!.id);
  });

  it("fully writes off the invoice, marks it WRITTEN_OFF, and increments the sequence", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Full WO Customer" });
    const inv = await mkInvoice(party, "INV-WO-2", parseMoney("500"));

    const wo = await db.transaction((tx) =>
      postWriteOff(tx, {
        companyId, branchId, partyId: party, salesDocId: inv, accountId: expenseAcctId,
        date: new Date(), amount: parseMoney("500"), createdById: userId,
      })
    );
    expect(wo.docNo).toMatch(/0002$/);
    const st = await docState(inv);
    expect(st.status).toBe("WRITTEN_OFF");
    expect(st.writtenOff).toBe(parseMoney("500"));
    expect(await partyBalance(party)).toBe(-parseMoney("500"));

    // Recover posts the exact reversal and restores everything.
    const rec = await db.transaction((tx) =>
      recoverWriteOff(tx, { companyId, writeOffId: wo.id, userId })
    );
    const rEntry = await entryBySource("WRITE_OFF_RECOVERY", wo.id);
    expect(rEntry!.id).toBe(rec.recoveryJournalEntryId);
    const rLines = await entryLines(rEntry!.id);
    expectEntryBalanced(rLines);
    expect(rLines.find((l) => l.accountId === arAcctId)).toMatchObject({ debit: parseMoney("500"), credit: 0n });
    expect(rLines.find((l) => l.accountId === expenseAcctId)).toMatchObject({ debit: 0n, credit: parseMoney("500") });

    const st2 = await docState(inv);
    expect(st2.writtenOff).toBe(0n);
    expect(st2.status).toBe("POSTED");
    expect(await partyBalance(party)).toBe(0n);
    const hdr = await db.select().from(writeOffs).where(eq(writeOffs.id, wo.id)).limit(1);
    expect(hdr[0]!.recoveredAt).not.toBeNull();

    await expect(
      db.transaction((tx) => recoverWriteOff(tx, { companyId, writeOffId: wo.id, userId }))
    ).rejects.toThrow(/already recovered/);
  });

  it("rejects write-off above the outstanding balance", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Over WO Customer" });
    const inv = await mkInvoice(party, "INV-WO-3", parseMoney("100"));
    await expect(
      db.transaction((tx) =>
        postWriteOff(tx, {
          companyId, branchId, partyId: party, salesDocId: inv, accountId: expenseAcctId,
          date: new Date(), amount: parseMoney("101"), createdById: userId,
        })
      )
    ).rejects.toThrow(/exceeds/);
  });

  it("is blocked in a locked period", async () => {
    const party = crypto.randomUUID();
    await db.insert(s.parties).values({ id: party, companyId, kind: "CUSTOMER", name: "Locked WO Customer" });
    const inv = await mkInvoice(party, "INV-WO-4", parseMoney("100"));
    await lockPeriod(new Date("2099-01-01T00:00:00Z"));
    try {
      await expect(
        db.transaction((tx) =>
          postWriteOff(tx, {
            companyId, branchId, partyId: party, salesDocId: inv, accountId: expenseAcctId,
            date: new Date(), amount: parseMoney("10"), createdById: userId,
          })
        )
      ).rejects.toThrow(/locked/i);
    } finally {
      await lockPeriod(null);
    }
  });
});

// ─── G8 expense void ────────────────────────────────────────────

describe("G8 expense void", () => {
  it("voids an expense: reversing journal balances, bank balance restored, marker stamped", async () => {
    const cashBefore = await bankBalance(cashId);
    const expId = await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expenseAcctId, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("100"), taxAmount: parseMoney("16"),
        notes: "void me", createdById: userId,
      })
    );
    expect(await bankBalance(cashId)).toBe(cashBefore - parseMoney("116"));

    const v = await db.transaction((tx) =>
      voidExpense(tx, { companyId, expenseId: expId, reason: "duplicate entry", userId })
    );

    const voidEntry = await entryBySource("EXPENSE_VOID", expId);
    expect(voidEntry!.id).toBe(v.voidJournalEntryId);
    const vLines = await entryLines(voidEntry!.id);
    expectEntryBalanced(vLines);
    // Net effect of original + reversal is zero per account.
    const expRow = (await db.select().from(s.expenses).where(eq(s.expenses.id, expId)).limit(1))[0]!;
    const net = new Map<string, bigint>();
    for (const l of [...(await entryLines(expRow.journalEntryId!)), ...vLines]) {
      net.set(l.accountId, (net.get(l.accountId) ?? 0n) + l.debit - l.credit);
    }
    for (const n of net.values()) expect(n).toBe(0n);
    // Bank balance restored, voided marker stamped.
    expect(await bankBalance(cashId)).toBe(cashBefore);
    expect(await expenseVoidedAt(expId)).not.toBeNull();

    await expect(
      db.transaction((tx) => voidExpense(tx, { companyId, expenseId: expId, userId }))
    ).rejects.toThrow(/already voided/);
  });

  it("is blocked in a locked period", async () => {
    const expId = await db.transaction((tx) =>
      postExpense(tx, {
        companyId, branchId, accountId: expenseAcctId, bankAccountId: cashId,
        date: new Date(), amount: parseMoney("20"), taxAmount: 0n, createdById: userId,
      })
    );
    await lockPeriod(new Date("2099-01-01T00:00:00Z"));
    try {
      await expect(
        db.transaction((tx) => voidExpense(tx, { companyId, expenseId: expId, userId }))
      ).rejects.toThrow(/locked/i);
    } finally {
      await lockPeriod(null);
    }
  });
});

// ─── global invariant ─────────────────────────────────────────

describe("FIX-3 global invariants", () => {
  it("every journal entry posted by these features balances with a positive total", async () => {
    const entries = await db
      .select({ id: s.journalEntries.id, source: s.journalEntries.source })
      .from(s.journalEntries)
      .where(eq(s.journalEntries.companyId, companyId));
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, e.id));
      const d = lines.reduce((a, l) => a + l.debit, 0n);
      const c = lines.reduce((a, l) => a + l.credit, 0n);
      expect(d, `entry ${e.id} (${e.source})`).toBe(c);
      expect(d, `entry ${e.id} (${e.source})`).toBeGreaterThan(0n);
    }
  });
});
