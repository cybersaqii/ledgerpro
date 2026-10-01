/**
 * QA doc-flow fixes (W3): CHALLAN→INVOICE conversion, branch stock
 * transfers, and credit/debit notes netting the source invoice's
 * outstanding.
 *
 * - Challan semantics (verified in app/api/sales/route.ts): POSTED_TYPES is
 *   ["INVOICE","RETURN"], so a challan is always a DRAFT that never posts
 *   stock or journals. Converting it posts stock + journals exactly once via
 *   the same postSalesDoc path as an order conversion; the CONVERTED status
 *   stamp blocks a second conversion.
 * - Stock transfers move quantity between branches with no value/P&L
 *   impact: the moved quantity carries the source branch's moving-average
 *   cost, so total stock value is conserved.
 * - A credit/debit note linked to an invoice/bill (source_doc_id, which
 *   already existed — no migration needed) grows that document's
 *   returnedTotal, so outstanding (grandTotal − amountPaid − returnedTotal −
 *   writtenOff) nets off like a return does.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { postSalesDoc } from "@/lib/posting";
import { convertSalesDoc } from "@/lib/doc-actions";
import { transferStock } from "@/lib/stock-transfer";
import { postNote } from "@/lib/notes";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let branchBId = "";
let customerId = "";
let productId = "";

function item(pid: string, qty: string, rate: string): DocItemInput {
  return {
    productId: pid,
    description: "QA docflow item",
    qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate),
    discountPaisa: 0n,
    taxBps: 0,
  };
}

async function trialBalanceZero(): Promise<boolean> {
  const rows = await db
    .select({
      d: sql<string>`coalesce(sum(${s.journalLines.debit}), 0)`,
      c: sql<string>`coalesce(sum(${s.journalLines.credit}), 0)`,
    })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(eq(s.journalEntries.companyId, companyId));
  return BigInt(rows[0].d) === BigInt(rows[0].c);
}

/** Half-up paisa value of a stock level, the same convention reports use. */
function levelValue(qtyMilli: bigint, avgCost: bigint): bigint {
  return (qtyMilli * avgCost + 500n) / 1000n;
}

async function stockOf(product: string, branch: string): Promise<{ qty: bigint; avg: bigint }> {
  const [r] = await db
    .select()
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.productId, product), eq(s.stockLevels.branchId, branch)))
    .limit(1);
  return { qty: BigInt(r?.qty ?? 0n), avg: BigInt(r?.avgCost ?? 0n) };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  // setupCompany seeds branches/accounts/sequences but not the companies
  // row itself; notes.company_id carries a real FK, so insert it.
  await db.insert(s.companies).values({ id: companyId, name: "QA Docflow Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  branchBId = crypto.randomUUID();
  await db.insert(s.branches).values({ id: branchBId, companyId, name: "QA Godown B", isDefault: false });

  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: customerId, companyId, kind: "CUSTOMER", name: "QA Docflow Customer" });
  await db.insert(s.products).values({
    id: productId, companyId, sku: "QADF-1", name: "QA Docflow Widget", unit: "PCS", trackStock: true,
  });
  // 10 units @ Rs 50 in the main branch.
  await db.insert(s.stockLevels).values({
    id: crypto.randomUUID(), productId, branchId, qty: 10000n, avgCost: parseMoney("50"),
  });
});

afterAll(() => cleanup());

describe("CHALLAN -> INVOICE conversion", () => {
  let challanId = "";

  it("posts stock and journals exactly once, then blocks a second conversion", async () => {
    const before = await stockOf(productId, branchId);
    expect(before.qty).toBe(10000n);

    // A challan is a DRAFT delivery note: no stock, no journal.
    challanId = crypto.randomUUID();
    const items = [item(productId, "2", "60")];
    const totals = computeTotals(items, 0n);
    await db.insert(s.salesDocs).values({
      id: challanId, companyId, branchId, partyId: customerId, docType: "CHALLAN",
      docNo: "CHL-0001", date: new Date(), status: "DRAFT",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await db.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId: challanId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const afterDraft = await stockOf(productId, branchId);
    expect(afterDraft.qty).toBe(before.qty); // challan draft moved nothing

    const result = await db.transaction((tx) =>
      convertSalesDoc(tx, { companyId, branchId, sourceId: challanId, userId })
    );

    const [inv] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, result.docId)).limit(1);
    expect(inv.docType).toBe("INVOICE");
    expect(inv.status).toBe("POSTED");
    expect(BigInt(inv.grandTotal)).toBe(totals.grandTotal);
    expect(inv.sourceDocId).toBe(challanId);

    // stock moved exactly once: −2 units
    const after = await stockOf(productId, branchId);
    expect(after.qty).toBe(before.qty - 2000n);

    // journals balance across the company
    expect(await trialBalanceZero()).toBe(true);

    // source is stamped CONVERTED
    const [src] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, challanId)).limit(1);
    expect(src.status).toBe("CONVERTED");

    // second conversion is rejected (422)
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: challanId, userId }))
    ).rejects.toMatchObject({ status: 422 });
    const still = await stockOf(productId, branchId);
    expect(still.qty).toBe(after.qty); // nothing moved again
  });

  it("rejects non-convertible source types", async () => {
    const invId = crypto.randomUUID();
    const items = [item(productId, "1", "60")];
    const totals = computeTotals(items, 0n);
    await db.insert(s.salesDocs).values({
      id: invId, companyId, branchId, partyId: customerId, docType: "INVOICE",
      docNo: "INV-ODD", date: new Date(), status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await expect(
      db.transaction((tx) => convertSalesDoc(tx, { companyId, branchId, sourceId: invId, userId }))
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe("branch stock transfer", () => {
  it("moves quantity with no value/P&L impact and keeps a moving average", async () => {
    // destination already holds 4 units @ Rs 50 — numbers chosen so the
    // half-up moving average divides evenly.
    await db.insert(s.stockLevels).values({
      id: crypto.randomUUID(), productId, branchId: branchBId, qty: 4000n, avgCost: parseMoney("50"),
    });
    const aBefore = await stockOf(productId, branchId);
    const bBefore = await stockOf(productId, branchBId);
    const valueBefore = levelValue(aBefore.qty, aBefore.avg) + levelValue(bBefore.qty, bBefore.avg);

    const r = await db.transaction((tx) =>
      transferStock(tx, {
        companyId, productId, fromBranchId: branchId, toBranchId: branchBId,
        qtyMilli: parseQty("3"), date: new Date(),
      })
    );

    const aAfter = await stockOf(productId, branchId);
    const bAfter = await stockOf(productId, branchBId);
    expect(aAfter.qty).toBe(aBefore.qty - 3000n); // source −N
    expect(bAfter.qty).toBe(bBefore.qty + 3000n); // dest +N
    // source keeps its own average; dest absorbs the moved qty at the
    // source's average → (4000*50 + 3000*50)/7000 = Rs 50 exactly
    expect(aAfter.avg).toBe(aBefore.avg);
    expect(bAfter.avg).toBe(parseMoney("50"));

    const valueAfter = levelValue(aAfter.qty, aAfter.avg) + levelValue(bAfter.qty, bAfter.avg);
    expect(valueAfter).toBe(valueBefore); // total value unchanged

    // no journal entries were posted for the transfer
    expect(await trialBalanceZero()).toBe(true);
    expect(r.fromBranchName).toBe("Main Branch");
    expect(r.toBranchName).toBe("QA Godown B");
  });

  it("creates the destination level on first transfer", async () => {
    const p2 = crypto.randomUUID();
    await db.insert(s.products).values({
      id: p2, companyId, sku: "QADF-2", name: "QA Second Widget", unit: "PCS", trackStock: true,
    });
    await db.insert(s.stockLevels).values({
      id: crypto.randomUUID(), productId: p2, branchId, qty: 5000n, avgCost: parseMoney("80"),
    });
    await db.transaction((tx) =>
      transferStock(tx, {
        companyId, productId: p2, fromBranchId: branchId, toBranchId: branchBId,
        qtyMilli: parseQty("5"), date: new Date(),
      })
    );
    const dest = await stockOf(p2, branchBId);
    expect(dest.qty).toBe(5000n);
    expect(dest.avg).toBe(parseMoney("80")); // moved qty keeps the source's average
  });

  it("rejects insufficient stock, same branch, and unknown branches (422)", async () => {
    await expect(
      db.transaction((tx) =>
        transferStock(tx, {
          companyId, productId, fromBranchId: branchId, toBranchId: branchBId,
          qtyMilli: parseQty("9999"), date: new Date(),
        })
      )
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      db.transaction((tx) =>
        transferStock(tx, {
          companyId, productId, fromBranchId: branchId, toBranchId: branchId,
          qtyMilli: parseQty("1"), date: new Date(),
        })
      )
    ).rejects.toMatchObject({ status: 422 });

    await expect(
      db.transaction((tx) =>
        transferStock(tx, {
          companyId, productId, fromBranchId: branchId, toBranchId: crypto.randomUUID(),
          qtyMilli: parseQty("1"), date: new Date(),
        })
      )
    ).rejects.toMatchObject({ status: 422 });
  });
});

describe("credit note against an invoice", () => {
  let invId = "";
  const grand = parseMoney("500"); // Rs 500 invoice

  beforeAll(async () => {
    invId = crypto.randomUUID();
    const items = [item(productId, "1", "500")];
    const totals = computeTotals(items, 0n);
    expect(totals.grandTotal).toBe(grand);
    await db.transaction(async (tx) => {
      await tx.insert(s.salesDocs).values({
        id: invId, companyId, branchId, partyId: customerId, docType: "INVOICE",
        docNo: "INV-QADF", date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      const entryId = await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId: invId, docNo: "INV-QADF",
        docType: "INVOICE", date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: false })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, invId));
    });
  });

  async function outstandingOf(id: string): Promise<bigint> {
    const [d] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, id)).limit(1);
    return BigInt(d.grandTotal) - BigInt(d.amountPaid) - BigInt(d.returnedTotal ?? 0n) - BigInt(d.writtenOffAmount ?? 0n);
  }

  it("nets the invoice outstanding down by the note amount", async () => {
    expect(await outstandingOf(invId)).toBe(grand);
    await db.transaction((tx) =>
      postNote(tx, {
        companyId, branchId, kind: "CREDIT", partyId: customerId, date: new Date(),
        amount: parseMoney("50"), sourceDocId: invId, createdById: userId,
      })
    );
    expect(await outstandingOf(invId)).toBe(grand - parseMoney("50")); // X − 50
    const [d] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invId)).limit(1);
    expect(BigInt(d.returnedTotal ?? 0n)).toBe(parseMoney("50"));
    expect(await trialBalanceZero()).toBe(true);
  });

  it("rejects a note larger than the outstanding balance", async () => {
    await expect(
      db.transaction((tx) =>
        postNote(tx, {
          companyId, branchId, kind: "CREDIT", partyId: customerId, date: new Date(),
          amount: grand, sourceDocId: invId, createdById: userId,
        })
      )
    ).rejects.toMatchObject({ status: 422 });
    // outstanding unchanged after the rejected note
    expect(await outstandingOf(invId)).toBe(grand - parseMoney("50"));
  });

  it("marks the invoice PAID when the note covers the full balance", async () => {
    const rest = await outstandingOf(invId);
    await db.transaction((tx) =>
      postNote(tx, {
        companyId, branchId, kind: "CREDIT", partyId: customerId, date: new Date(),
        amount: rest, sourceDocId: invId, createdById: userId,
      })
    );
    const [d] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, invId)).limit(1);
    expect(await outstandingOf(invId)).toBe(0n);
    expect(d.status).toBe("PAID");
  });
});
