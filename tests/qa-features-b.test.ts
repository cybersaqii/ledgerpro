/**
 * FIX-4 feature tests: bank reconciliation, product-sales report (COGS/P&L
 * agreement), credit/debit notes, and party categories.
 *
 * New columns/tables from migrations 0025/0026 are accessed via db/schema.ts
 * (the query builder is used everywhere — drizzle-orm 0.44 removed runtime
 * `db.execute`).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postNote } from "@/lib/notes";
import { getRecLines, recBalances, unclearedNetOf } from "@/lib/reconciliation";
import { buildProductSalesReport, allocateCogs } from "@/lib/product-report";

import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let supplierId = "";
let customerId = "";
let prodAId = "";
let prodBId = "";
let bankGlId = "";
let bankAcctId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "FIX-4 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  prodAId = crypto.randomUUID();
  prodBId = crypto.randomUUID();
  await db.insert(s.parties).values([
    { id: supplierId, companyId, kind: "SUPPLIER", name: "Note Supplier" },
    { id: customerId, companyId, kind: "CUSTOMER", name: "Note Customer" },
  ]);
  await db.insert(s.products).values([
    { id: prodAId, companyId, sku: "WID-A", name: "Widget A", unit: "PCS", salePrice: parseMoney("150"), category: "Electronics" },
    { id: prodBId, companyId, sku: "WID-B", name: "Widget B", unit: "PCS", salePrice: parseMoney("300"), category: "Grocery" },
  ]);

  // A bank GL account + bank_accounts row for the reconciliation tests.
  bankGlId = crypto.randomUUID();
  await db.insert(s.accounts).values({
    id: bankGlId, companyId, code: "1099", name: "Test Bank", type: "ASSET", isActive: true,
  });
  bankAcctId = crypto.randomUUID();
  await db.insert(s.bankAccounts).values({
    id: bankAcctId, companyId, name: "Test Bank", kind: "BANK", accountId: bankGlId,
  });
});

afterAll(() => cleanup());

// ─── helpers ────────────────────────────────────────────────────

async function stockIn(productId: string, rate: string) {
  const items: DocItemInput[] = [
    { productId, description: "stock in", qtyMilli: parseQty("100"), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "BILL");
    const id = crypto.randomUUID();
    await tx.insert(s.purchaseDocs).values({
      id, companyId, branchId, partyId: supplierId, docType: "BILL", docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await postPurchaseDoc(tx, {
      companyId, branchId, partyId: supplierId, docId: id, docNo, docType: "BILL",
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
  });
}

async function postInvoice(items: DocItemInput[]): Promise<string> {
  const totals = computeTotals(items, 0n);
  const docId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType: "INVOICE", docNo,
      date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId, docNo, docType: "INVOICE",
      date: new Date(), items: totals.items.map((i) => ({ ...i, trackStock: true })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
  });
  return docId;
}

/** Insert one journal entry with a debit to the test bank GL account. */
let contraSeq = 0;
async function bankJournalLine(opts: {
  date?: Date; memo?: string; source?: string; sourceId?: string | null;
  debit?: bigint; credit?: bigint; partyId?: string | null;
}): Promise<string> {
  const entryId = crypto.randomUUID();
  const lineId = crypto.randomUUID();
  const debit = opts.debit ?? 0n;
  const credit = opts.credit ?? 0n;
  const contra = crypto.randomUUID();
  contraSeq += 1;
  await db.insert(s.accounts).values({
    id: contra, companyId, code: `89${String(contraSeq).padStart(2, "0")}`, name: `Contra ${contraSeq}`, type: "EXPENSE", isActive: true,
  });
  await db.insert(s.journalEntries).values({
    id: entryId, companyId, branchId, date: opts.date ?? new Date(),
    memo: opts.memo ?? "test line", source: opts.source ?? "PAYMENT",
    sourceId: opts.sourceId ?? null, createdById: userId,
  });
  await db.insert(s.journalLines).values([
    { id: lineId, entryId, accountId: bankGlId, debit, credit, partyId: opts.partyId ?? null },
    { id: crypto.randomUUID(), entryId, accountId: contra, debit: credit, credit: debit },
  ]);
  return lineId;
}

async function clearLine(lineId: string, clearedAt: number) {
  await db.insert(s.reconciliationClears).values({
    id: crypto.randomUUID(), companyId, bankAccountId: bankAcctId, journalLineId: lineId,
    clearedAt: new Date(clearedAt), clearedById: userId, createdAt: new Date(),
  });
}

async function noteKind(id: string): Promise<string> {
  const rows = await db.select({ kind: s.notes.kind, sourceDocId: s.notes.sourceDocId }).from(s.notes).where(eq(s.notes.id, id));
  return `${rows[0].kind}|${rows[0].sourceDocId ?? ""}`;
}

async function partyBalance(partyId: string): Promise<bigint> {
  const rows = await db.select({ balance: s.parties.balance }).from(s.parties).where(eq(s.parties.id, partyId));
  return rows[0]?.balance ?? 0n;
}

// ─── bank reconciliation ────────────────────────────────────────

describe("bank reconciliation", () => {
  it("lists uncleared lines and drives the difference to zero once cleared", async () => {
    const lineId = await bankJournalLine({ debit: parseMoney("10000"), memo: "Customer receipt" });
    const acct = { id: bankAcctId, accountId: bankGlId };

    let lines = await getRecLines(db, companyId, acct);
    expect(lines.some((l) => l.lineId === lineId && l.clearedAt == null)).toBe(true);

    const book = lines.reduce((a, l) => a + l.debit - l.credit, 0n);
    const uncleared = unclearedNetOf(lines);
    const before = recBalances(book, uncleared);
    expect(before.difference).toBe(uncleared);
    expect(before.clearedBalance).toBe(book - uncleared);

    await clearLine(lineId, Date.now());
    lines = await getRecLines(db, companyId, acct);
    const clearedLine = lines.find((l) => l.lineId === lineId);
    expect(clearedLine?.clearedAt).not.toBeNull();

    const after = recBalances(book, unclearedNetOf(lines));
    expect(after.difference).toBe(0n);
    expect(after.clearedBalance).toBe(book);
  });

  it("suggests the PDC's own cleared date for cleared cheques", async () => {
    const chequeId = crypto.randomUUID();
    const clearedAt = Date.now() - 86400000;
    await db.insert(s.pdcCheques).values({
      id: chequeId, companyId, branchId, kind: "RECEIVED", partyId: customerId,
      chequeNo: "CHQ-1", amount: parseMoney("5000"), chequeDate: new Date(),
      status: "CLEARED", clearedAt: new Date(clearedAt), createdById: userId,
    });
    await bankJournalLine({ debit: parseMoney("5000"), source: "PDC_CLEAR", sourceId: chequeId, memo: "PDC cleared" });

    const lines = await getRecLines(db, companyId, { id: bankAcctId, accountId: bankGlId });
    const pdcLine = lines.find((l) => l.source === "PDC_CLEAR");
    expect(pdcLine).toBeDefined();
    expect(pdcLine!.suggestedClearedAt).toBe(clearedAt);
    expect(pdcLine!.clearedAt).toBeNull();
  });
});

// ─── product sales report ───────────────────────────────────────

describe("product sales report", () => {
  beforeAll(async () => {
    await stockIn(prodAId, "100"); // 100 pcs @ Rs 100
    await stockIn(prodBId, "200"); // 100 pcs @ Rs 200
    await postInvoice([
      { productId: prodAId, description: "Widget A", qtyMilli: parseQty("10"), ratePaisa: parseMoney("150"), discountPaisa: 0n, taxBps: 0 },
      { productId: prodBId, description: "Widget B", qtyMilli: parseQty("5"), ratePaisa: parseMoney("300"), discountPaisa: 0n, taxBps: 0 },
    ]);
  });

  it("reports per-product qty, sale value, COGS, gross profit and margin", async () => {
    const r = await buildProductSalesReport(db, companyId, {});
    expect(r.docCount).toBe(1);
    expect(r.rows).toHaveLength(2);

    const a = r.rows.find((x) => x.productId === prodAId)!;
    expect(a.qtySold).toBe(parseQty("10").toString());
    expect(BigInt(a.saleValue)).toBe(10n * parseMoney("150"));
    expect(BigInt(a.cogs)).toBe(10n * parseMoney("100")); // moving-average cost
    expect(BigInt(a.grossProfit)).toBe(BigInt(a.saleValue) - BigInt(a.cogs));
    expect(a.marginPct).toBeCloseTo(33.333, 1);

    const b = r.rows.find((x) => x.productId === prodBId)!;
    expect(BigInt(b.cogs)).toBe(5n * parseMoney("200"));
  });

  it("agrees with the journal-posted COGS (the P&L figure) exactly", async () => {
    const r = await buildProductSalesReport(db, companyId, {});
    // Report-internal agreement: allocated per-product COGS == posted total.
    expect(BigInt(r.postedCogs)).toBe(r.rows.reduce((acc, x) => acc + BigInt(x.cogs), 0n));

    // External agreement: posted total == the COGS account in the journals.
    const cogsAcct = await db.select({ id: s.accounts.id }).from(s.accounts).where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, SYS.COGS))).limit(1);
    const rows = await db
      .select({ debit: s.journalLines.debit, credit: s.journalLines.credit })
      .from(s.journalLines)
      .innerJoin(s.journalEntries, eq(s.journalEntries.id, s.journalLines.entryId))
      .where(and(
        eq(s.journalEntries.companyId, companyId),
        eq(s.journalEntries.source, "SALES"),
        eq(s.journalLines.accountId, cogsAcct[0].id),
      ));
    const journalCogs = rows.reduce((acc, x) => acc + x.debit - x.credit, 0n);
    expect(BigInt(r.postedCogs)).toBe(journalCogs);
    expect(BigInt(r.totals.cogs)).toBe(journalCogs);
  });

  it("filters by product category", async () => {
    const r = await buildProductSalesReport(db, companyId, { category: "Electronics" });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].productId).toBe(prodAId);
  });

  it("allocateCogs distributes paisa remainders without losing any", () => {
    const shares = allocateCogs(100n, [1n, 1n, 1n]);
    expect(shares.reduce((a, b) => a + b, 0n)).toBe(100n);
    expect(Math.max(...shares.map(Number)) - Math.min(...shares.map(Number))).toBeLessThanOrEqual(1);
    expect(allocateCogs(0n, [5n]).reduce((a, b) => a + b, 0n)).toBe(0n);
  });
});

// ─── credit / debit notes ───────────────────────────────────────

describe("credit/debit notes", () => {
  it("posts a balanced credit note with a CN- number and reduces the customer balance", async () => {
    const before = await partyBalance(customerId);
    let result!: { id: string; docNo: string; journalEntryId: string };
    await db.transaction(async (tx) => {
      result = await postNote(tx, {
        companyId, branchId, kind: "CREDIT", partyId: customerId,
        date: new Date(), amount: parseMoney("500"), createdById: userId,
      });
    });
    expect(result.docNo.startsWith("CN-")).toBe(true);

    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, result.journalEntryId));
    expect(lines.length).toBe(2);
    const debits = lines.reduce((a, l) => a + l.debit, 0n);
    const credits = lines.reduce((a, l) => a + l.credit, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(parseMoney("500"));

    expect(await noteKind(result.id)).toBe("CREDIT_NOTE|");

    expect(await partyBalance(customerId)).toBe(before - parseMoney("500"));
  });

  it("posts a balanced debit note with a DN- number and reduces the supplier balance", async () => {
    const before = await partyBalance(supplierId);
    let result!: { id: string; docNo: string; journalEntryId: string };
    await db.transaction(async (tx) => {
      result = await postNote(tx, {
        companyId, branchId, kind: "DEBIT", partyId: supplierId,
        date: new Date(), amount: parseMoney("250"), createdById: userId,
      });
    });
    expect(result.docNo.startsWith("DN-")).toBe(true);

    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, result.journalEntryId));
    const debits = lines.reduce((a, l) => a + l.debit, 0n);
    const credits = lines.reduce((a, l) => a + l.credit, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(parseMoney("250"));

    expect(await noteKind(result.id)).toBe("DEBIT_NOTE|");
    expect(await partyBalance(supplierId)).toBe(before - parseMoney("250"));
  });

  it("links the note to its source document", async () => {
    const docId = await postInvoice([
      { productId: prodAId, description: "Widget A", qtyMilli: parseQty("1"), ratePaisa: parseMoney("150"), discountPaisa: 0n, taxBps: 0 },
    ]);
    let result!: { id: string; docNo: string; journalEntryId: string };
    await db.transaction(async (tx) => {
      result = await postNote(tx, {
        companyId, branchId, kind: "CREDIT", partyId: customerId,
        date: new Date(), amount: parseMoney("50"), sourceDocId: docId, createdById: userId,
      });
    });
    expect(await noteKind(result.id)).toBe(`CREDIT_NOTE|${docId}`);

    // The source doc now has a note in its history.
    const linked = await db.select({ id: s.notes.id }).from(s.notes).where(eq(s.notes.sourceDocId, docId));
    expect(linked.map((r) => r.id)).toContain(result.id);
  });

  it("rejects the wrong party side and non-positive amounts", async () => {
    await expect(
      db.transaction((tx) =>
        postNote(tx, {
          companyId, branchId, kind: "CREDIT", partyId: supplierId,
          date: new Date(), amount: parseMoney("10"), createdById: userId,
        })
      )
    ).rejects.toThrow(UserError);
    await expect(
      db.transaction((tx) =>
        postNote(tx, {
          companyId, branchId, kind: "DEBIT", partyId: customerId,
          date: new Date(), amount: parseMoney("10"), createdById: userId,
        })
      )
    ).rejects.toThrow(UserError);
    await expect(
      db.transaction((tx) =>
        postNote(tx, {
          companyId, branchId, kind: "CREDIT", partyId: customerId,
          date: new Date(), amount: 0n, createdById: userId,
        })
      )
    ).rejects.toThrow(UserError);
  });
});

// ─── party categories ───────────────────────────────────────────

describe("party categories", () => {
  it("stores categories and filters parties by them (the ?category= API contract)", async () => {
    await db.update(s.parties).set({ category: "Retailer" }).where(eq(s.parties.id, customerId));
    await db.update(s.parties).set({ category: "Distributor" }).where(eq(s.parties.id, supplierId));

    // Same predicate the GET /api/parties route uses (parties.category = ?).
    const rows = await db.select({ id: s.parties.id }).from(s.parties).where(eq(s.parties.category, "Retailer"));
    expect(rows.map((r) => r.id)).toContain(customerId);

    const cat = await db.select({ category: s.parties.category }).from(s.parties).where(eq(s.parties.id, customerId));
    expect(cat[0].category).toBe("Retailer");
  });

  it("defaults the company invoice format to 80mm", async () => {
    const rows = await db.select({ fmt: s.companies.defaultInvoiceFormat }).from(s.companies).where(eq(s.companies.id, companyId));
    expect(rows[0].fmt).toBe("80mm");
  });
});
