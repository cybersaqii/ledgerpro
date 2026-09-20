// Sample (demo) data for onboarding: a tiny, clearly-labeled dataset a new
// owner can load with one click to explore the app before entering real data.
//
// Accounting-safety rules:
// - Every sample row is prefixed "SAMPLE-" (names, SKUs, doc numbers).
// - Sale/purchase documents are created as DRAFTs and the sample expense is
//   left unposted (no journal entry), so sample data NEVER touches journals,
//   stock levels, party balances, or reports. Real balances stay real.
// - Loading is blocked when the company already has real parties/products.
// - Every created row is recorded in sample_manifest, so removal deletes
//   exactly those rows and nothing else.

import { and, count, eq, inArray, like, not } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  expenses,
  parties,
  products,
  purchaseDocItems,
  purchaseDocs,
  salesDocItems,
  salesDocs,
  sampleManifest,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { defaultBranchId } from "./route-helpers";
import { assertPeriodOpen } from "./period";
import { logAudit } from "./audit";
import { UserError } from "./errors";

export const SAMPLE_PREFIX = "SAMPLE-";

/** True when the company has any non-sample parties or products. */
export async function hasRealData(dbc: Db | DbTx, companyId: string): Promise<boolean> {
  const [[p], [pr]] = await Promise.all([
    dbc
      .select({ n: count() })
      .from(parties)
      .where(and(eq(parties.companyId, companyId), not(like(parties.name, `${SAMPLE_PREFIX}%`)))),
    dbc
      .select({ n: count() })
      .from(products)
      .where(and(eq(products.companyId, companyId), not(like(products.sku, `${SAMPLE_PREFIX}%`)))),
  ]);
  return p.n > 0 || pr.n > 0;
}

/** True when sample data is currently loaded for the company. */
export async function isSampleLoaded(dbc: Db | DbTx, companyId: string): Promise<boolean> {
  const rows = await dbc
    .select({ n: count() })
    .from(sampleManifest)
    .where(eq(sampleManifest.companyId, companyId));
  return (rows[0]?.n ?? 0) > 0;
}

async function manifest(tx: DbTx, companyId: string, tableName: string, rowIds: string[]): Promise<void> {
  if (!rowIds.length) return;
  await tx.insert(sampleManifest).values(
    rowIds.map((rowId) => ({
      id: crypto.randomUUID(),
      companyId,
      tableName,
      rowId,
    }))
  );
}

/** Load the demo dataset in one transaction. Throws UserError when blocked. */
export async function loadSampleData(
  dbc: Db,
  input: { companyId: string; userId: string; userName: string }
): Promise<{ parties: number; products: number; docs: number }> {
  const { companyId, userId, userName } = input;
  if (await hasRealData(dbc, companyId)) {
    throw new UserError("Sample data can only be loaded into a brand-new company. Your real parties and products are already here — no need for demos.");
  }
  if (await isSampleLoaded(dbc, companyId)) {
    throw new UserError("Sample data is already loaded. Remove it first if you want to reload.");
  }

  return dbc.transaction(async (tx) => {
    await assertPeriodOpen(tx, companyId, new Date());
    const branchId = await defaultBranchId(tx, companyId);

    const [gl] = await tx
      .select({ id: accounts.id })
      .from(accounts)
      .where(and(eq(accounts.companyId, companyId), eq(accounts.type, "EXPENSE"), eq(accounts.isActive, true)))
      .limit(1);
    const [bank] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)))
      .limit(1);
    if (!gl || !bank) throw new UserError("Your chart of accounts is not set up yet. Contact support.");

    const now = new Date();
    const partyRows = [
      { kind: "CUSTOMER", name: `${SAMPLE_PREFIX}Ahmed Store`, phone: "0300-1111111", city: "Lahore" },
      { kind: "SUPPLIER", name: `${SAMPLE_PREFIX}Rana Suppliers`, phone: "0300-2222222", city: "Lahore" },
    ] as const;
    const partyIds: Record<string, string> = {};
    for (const p of partyRows) {
      const id = crypto.randomUUID();
      await tx.insert(parties).values({
        id, companyId, kind: p.kind, name: p.name,
        phone: p.phone, city: p.city, creditLimit: 0n, balance: 0n, isActive: true,
        notes: "Sample data — demo only. Delete it from Settings once you start real entry.",
      });
      partyIds[p.kind] = id;
    }
    await manifest(tx, companyId, "parties", Object.values(partyIds));

    const productDefs = [
      { sku: `${SAMPLE_PREFIX}TEA-001`, name: `${SAMPLE_PREFIX}Tea 950g`, category: "Grocery", pp: 85000n, sp: 95000n },
      { sku: `${SAMPLE_PREFIX}SUG-002`, name: `${SAMPLE_PREFIX}Sugar 5kg`, category: "Grocery", pp: 70000n, sp: 78000n },
      { sku: `${SAMPLE_PREFIX}RIC-003`, name: `${SAMPLE_PREFIX}Rice 20kg`, category: "Grocery", pp: 320000n, sp: 350000n },
    ];
    const productIds: Record<string, string> = {};
    for (const p of productDefs) {
      const id = crypto.randomUUID();
      await tx.insert(products).values({
        id, companyId, sku: p.sku, name: p.name, category: p.category,
        unit: "PCS", purchasePrice: p.pp, salePrice: p.sp, minSalePrice: 0n,
        trackStock: true, isActive: true,
      });
      productIds[p.sku] = id;
    }
    await manifest(tx, companyId, "products", Object.values(productIds));

    // Sample purchase bill (DRAFT — never posts to stock or the supplier balance).
    const purchaseId = crypto.randomUUID();
    const purchaseItems = [
      { productId: productIds[`${SAMPLE_PREFIX}TEA-001`]!, description: `${SAMPLE_PREFIX}Tea 950g`, qty: 10000n, rate: 85000n },
      { productId: productIds[`${SAMPLE_PREFIX}SUG-002`]!, description: `${SAMPLE_PREFIX}Sugar 5kg`, qty: 20000n, rate: 70000n },
    ];
    const purchaseTotal = purchaseItems.reduce((a, i) => a + (i.qty / 1000n) * i.rate, 0n);
    await tx.insert(purchaseDocs).values({
      id: purchaseId, companyId, branchId, partyId: partyIds["SUPPLIER"]!,
      docType: "BILL", docNo: `${SAMPLE_PREFIX}BILL-001`, date: now,
      status: "DRAFT", subtotal: purchaseTotal, discountTotal: 0n, taxTotal: 0n,
      grandTotal: purchaseTotal, amountPaid: 0n,
      notes: "Sample data — a draft. Open it and post it yourself to see how a purchase works.",
      createdById: userId,
    });
    const purchaseItemIds: string[] = [];
    for (const i of purchaseItems) {
      const id = crypto.randomUUID();
      await tx.insert(purchaseDocItems).values({
        id, docId: purchaseId, productId: i.productId, description: i.description,
        qty: i.qty, rate: i.rate, discount: 0n, taxBps: 0, taxAmount: 0n,
        lineTotal: (i.qty / 1000n) * i.rate, extraCost: 0n,
      });
      purchaseItemIds.push(id);
    }
    await manifest(tx, companyId, "purchase_docs", [purchaseId]);
    await manifest(tx, companyId, "purchase_doc_items", purchaseItemIds);

    // Sample sales invoice (DRAFT — never posts to stock or the customer balance).
    const saleId = crypto.randomUUID();
    const saleItems = [
      { productId: productIds[`${SAMPLE_PREFIX}TEA-001`]!, description: `${SAMPLE_PREFIX}Tea 950g`, qty: 5000n, rate: 95000n },
      { productId: productIds[`${SAMPLE_PREFIX}RIC-003`]!, description: `${SAMPLE_PREFIX}Rice 20kg`, qty: 2000n, rate: 350000n },
    ];
    const saleTotal = saleItems.reduce((a, i) => a + (i.qty / 1000n) * i.rate, 0n);
    await tx.insert(salesDocs).values({
      id: saleId, companyId, branchId, partyId: partyIds["CUSTOMER"]!,
      docType: "INVOICE", docNo: `${SAMPLE_PREFIX}INV-001`, date: now,
      status: "DRAFT", subtotal: saleTotal, discountTotal: 0n, taxTotal: 0n,
      grandTotal: saleTotal, amountPaid: 0n,
      notes: "Sample data — a draft. Open it and post it yourself to see how a sale works.",
      createdById: userId,
    });
    const saleItemIds: string[] = [];
    for (const i of saleItems) {
      const id = crypto.randomUUID();
      await tx.insert(salesDocItems).values({
        id, docId: saleId, productId: i.productId, description: i.description,
        qty: i.qty, rate: i.rate, discount: 0n, taxBps: 0, taxAmount: 0n,
        lineTotal: (i.qty / 1000n) * i.rate,
      });
      saleItemIds.push(id);
    }
    await manifest(tx, companyId, "sales_docs", [saleId]);
    await manifest(tx, companyId, "sales_doc_items", saleItemIds);

    // Sample expense (unposted — journalEntryId stays null, so reports are untouched).
    const expenseId = crypto.randomUUID();
    await tx.insert(expenses).values({
      id: expenseId, companyId, branchId, date: now,
      accountId: gl.id, bankAccountId: bank.id,
      amount: 150000n, taxAmount: 0n,
      notes: "SAMPLE — demo only, not posted to your books.",
      journalEntryId: null, createdById: userId,
    });
    await manifest(tx, companyId, "expenses", [expenseId]);

    await logAudit(tx, {
      companyId, userId, userName,
      action: "sample.loaded", entity: "sample",
      detail: "Sample demo data loaded (2 parties, 3 products, 1 purchase draft, 1 sale draft, 1 unposted expense)",
    });
    return { parties: 2, products: 3, docs: 3 };
  });
}

/** Remove exactly the rows the loader created — nothing else. */
export async function removeSampleData(
  dbc: Db,
  input: { companyId: string; userId: string; userName: string }
): Promise<{ removed: number }> {
  const { companyId, userId, userName } = input;
  const rows = await dbc
    .select({ tableName: sampleManifest.tableName, rowId: sampleManifest.rowId })
    .from(sampleManifest)
    .where(eq(sampleManifest.companyId, companyId));
  if (!rows.length) throw new UserError("No sample data to remove.");

  const byTable = new Map<string, string[]>();
  for (const r of rows) {
    const list = byTable.get(r.tableName) ?? [];
    list.push(r.rowId);
    byTable.set(r.tableName, list);
  }
  // Children before parents; everything else is inert (drafts / unposted).
  const order = [
    "sales_doc_items",
    "purchase_doc_items",
    "sales_docs",
    "purchase_docs",
    "expenses",
    "products",
    "parties",
  ] as const;
  const tables = { sales_doc_items: salesDocItems, purchase_doc_items: purchaseDocItems, sales_docs: salesDocs, purchase_docs: purchaseDocs, expenses, products, parties } as const;

  let removed = 0;
  await dbc.transaction(async (tx) => {
    for (const name of order) {
      const ids = byTable.get(name);
      if (!ids?.length) continue;
      await tx.delete(tables[name]).where(inArray(tables[name].id, ids));
      removed += ids.length;
    }
    await tx.delete(sampleManifest).where(eq(sampleManifest.companyId, companyId));
    await logAudit(tx, {
      companyId, userId, userName,
      action: "sample.removed", entity: "sample",
      detail: `Sample demo data removed (${removed} rows)`,
    });
  });
  return { removed };
}
