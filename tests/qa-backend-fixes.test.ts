/**
 * FIX-1 regression tests for the LedgerPro QA backend bugs B1–B6.
 * (B7 — the stock-adjustment feature — is out of scope for this pass.)
 *
 * B1: backup/restore preserves PDC cheques, batches, bundle components,
 *     batch lineage and set-off allocations; FKs are RESTRICT (no silent
 *     cascade); wipeCompanyData deletes child-before-parent.
 * B2: POST /api/pdc/[id]/[action] — clear / bounce / cancel (+ unknown → 404).
 * B3: split return sequences — SR- from SALE_RETURN, PR- from PURCHASE_RETURN,
 *     EXPENSE → EXP-, plus the other new prefixes; SALE_RETURN continues the
 *     legacy RETURN sequence.
 * B4: direct (no source doc) returns write doc_batch_usage rows.
 * B5: expenses get EXP- doc numbers (postExpense mints when omitted).
 * B6: POST /api/payments without a party → 422 (not 500).
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq, and, sql, getTableName, getTableColumns } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers";
import type { DbTx } from "@/lib/db";
import type { AnySQLiteTable } from "drizzle-orm/sqlite-core";
import { setupCompany, nextDocNo } from "@/lib/setup";
import { recordPdc } from "@/lib/pdc";
import { postSalesDoc, postPurchaseDoc, postExpense } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { buildBackupPayload, serializeBackup, validateBackupPayload } from "@/lib/backup";
import { restoreCompanyData, restorePreservedTables } from "@/lib/restore";
import { deleteCompanyData, isForeignKeyViolation } from "@/lib/company-delete";
import * as s from "@/db/schema";

// ─── Route-level tests (B2/B5/B6) ────────────────────────────────────────────
// These import the real Next route handlers. The routes reach "@/lib/db" lazily
// through the mocked route-helpers; DATABASE_URL is pointed at the isolated
// file DB by ./qa-routes-env (imported first above) before any lib module
// evaluates the db singleton.

const hoisted = vi.hoisted(() => ({
  cid: crypto.randomUUID(),
  uid: crypto.randomUUID(),
}));

vi.mock("@/lib/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-helpers")>();
  const dbm = await import("@/lib/db");
  return {
    ...actual,
    db: dbm.db,
    requirePermission: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Tester" },
      companyId: hoisted.cid,
    }),
  };
});

async function migrateFileDb(url: string): Promise<void> {
  const client = createClient({ url });
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("--");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      for (const stmt of text.split(";").map((x) => x.trim()).filter((x) => x.length > 0)) {
        await client.execute(stmt);
      }
    }
  } finally {
    client.close();
  }
}

// ─── Shared helpers ─────────────────────────────────────────────────────────



async function trialBalanceZero(dbc: TestDb, companyId: string): Promise<boolean> {
  const rows = await dbc
    .select({
      d: sql<string>`coalesce(sum(${s.journalLines.debit}), 0)`,
      c: sql<string>`coalesce(sum(${s.journalLines.credit}), 0)`,
    })
    .from(s.journalLines)
    .innerJoin(s.journalEntries, eq(s.journalLines.entryId, s.journalEntries.id))
    .where(eq(s.journalEntries.companyId, companyId));
  return BigInt(rows[0].d) === BigInt(rows[0].c);
}

async function tableCount(dbc: TestDb, table: AnySQLiteTable, companyId: string): Promise<number> {
  const cols = getTableColumns(table);
  const rows = await dbc
    .select({ id: cols.id })
    .from(table)
    .where(eq(cols.companyId, companyId));
  return rows.length;
}

// ═══════════════════════════════════════════════════════════════════════════
// B1 — backup/restore preservation + RESTRICT FKs
// ═══════════════════════════════════════════════════════════════════════════
describe("B1 — backup/restore preservation and restrict FKs", () => {
  let db: TestDb;
  let cleanup: () => void;
  let companyId: string, branchId: string, userId: string;
  let customerId: string, supplierId: string, productId: string;
  let bundleId: string, batchId: string;

  async function postPurchase(
    pid: string, qty: string, rate: string,
    docType: "BILL" | "RETURN" = "BILL",
    batch: { batchNo?: string | null; batchId?: string | null } = {}
  ): Promise<string> {
    const items: DocItemInput[] = [
      { productId: pid, description: "t", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const seqType = docType === "RETURN" ? "PURCHASE_RETURN" : docType;
      const docNo = await nextDocNo(tx, companyId, seqType);
      await tx.insert(s.purchaseDocs).values({
        id: docId, companyId, branchId, partyId: supplierId, docType, docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId, docNo, docType, date: new Date(),
        items: totals.items.map((i) => ({
          ...i, trackStock: true, batchNo: batch.batchNo ?? null, batchId: batch.batchId ?? null,
        })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
    return docId;
  }

  async function postSale(
    pid: string, qty: string, rate: string,
    docType: "INVOICE" | "RETURN" = "INVOICE",
    bid: string | null = null
  ): Promise<string> {
    const items: DocItemInput[] = [
      { productId: pid, description: "t", qtyMilli: parseQty(qty), ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const seqType = docType === "RETURN" ? "SALE_RETURN" : docType;
      const docNo = await nextDocNo(tx, companyId, seqType);
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: customerId, docType, docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId, docNo, docType, date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true, batchId: bid })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
    return docId;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    companyId = crypto.randomUUID();
    userId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: companyId, name: "QA Fix1 Co", businessType: "WHOLESALE" });
    ({ branchId } = await setupCompany(db, companyId));

    customerId = crypto.randomUUID();
    supplierId = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: customerId, companyId, name: "C1", kind: "CUSTOMER", balance: 0n },
      { id: supplierId, companyId, name: "S1", kind: "SUPPLIER", balance: 0n },
    ]);

    productId = crypto.randomUUID();
    bundleId = crypto.randomUUID();
    await db.insert(s.products).values([
      { id: productId, companyId, sku: "WIDGET-1", name: "Widget", trackStock: true, purchasePrice: parseMoney("10"), salePrice: parseMoney("15") },
      { id: bundleId, companyId, sku: "BUNDLE-1", name: "Widget Bundle", trackStock: true, purchasePrice: parseMoney("25"), salePrice: parseMoney("35") },
    ]);

    // Purchase 100 units into batch B1; sell 40 of them.
    await postPurchase(productId, "100", "10", "BILL", { batchNo: "B1" });
    const b = await db
      .select({ id: s.productBatches.id })
      .from(s.productBatches)
      .where(and(eq(s.productBatches.companyId, companyId), eq(s.productBatches.batchNo, "B1")))
      .limit(1);
    batchId = b[0].id;
    const saleDocId = await postSale(productId, "40", "15", "INVOICE", batchId);

    // PDC cheque received from the customer.
    await db.transaction((tx) =>
      recordPdc(tx, {
        companyId, branchId, kind: "RECEIVED", partyId: customerId,
        chequeNo: "CHQ-1", amount: parseMoney("500"), chequeDate: new Date(),
        createdById: userId,
      })
    );

    // Bundle with one component.
    await db.insert(s.bundleComponents).values({
      id: crypto.randomUUID(), companyId, bundleProductId: bundleId,
      componentProductId: productId, qtyThousandths: 2000,
    });

    // Set-off allocation against the sale invoice (linked to a real journal entry).
    const entryRows = await db
      .select({ id: s.journalEntries.id })
      .from(s.journalEntries)
      .where(eq(s.journalEntries.companyId, companyId))
      .limit(1);
    await db.insert(s.setoffAllocations).values({
      id: crypto.randomUUID(), companyId, setoffEntryId: entryRows[0].id,
      partyId: customerId, salesDocId: saleDocId,
      amount: parseMoney("100"),
    });
  });

  afterAll(() => cleanup());

  it("restorePreservedTables covers PDCs, batches, bundle components, lineage and set-offs", () => {
    const names = restorePreservedTables().map((t) => getTableName(t));
    for (const t of ["pdc_cheques", "product_batches", "doc_batch_usage", "bundle_components", "setoff_allocations"]) {
      expect(names).toContain(t);
    }
  });

  it("backup → restore preserves all five child tables and keeps the books balanced", async () => {
    expect(await trialBalanceZero(db, companyId)).toBe(true);
    const { payload, rowCounts } = await buildBackupPayload(db, companyId);
    expect(rowCounts.salesDocs).toBeGreaterThan(0);
    const raw = serializeBackup(payload);
    expect(validateBackupPayload(raw).ok).toBe(true);

    const before = {
      pdc: await tableCount(db, s.pdcCheques, companyId),
      batches: await tableCount(db, s.productBatches, companyId),
      lineage: (await db.select().from(s.docBatchUsage).where(eq(s.docBatchUsage.companyId, companyId))).length,
      bundles: await tableCount(db, s.bundleComponents, companyId),
      setoff: await tableCount(db, s.setoffAllocations, companyId),
    };
    expect(before.pdc).toBe(1);
    expect(before.batches).toBe(1);
    expect(before.lineage).toBe(2); // purchase receipt + sale deduction
    expect(before.bundles).toBe(1);
    expect(before.setoff).toBe(1);

    await db.transaction(async (tx) => {
      await restoreCompanyData(tx, companyId, JSON.parse(raw));
    });

    expect(await tableCount(db, s.pdcCheques, companyId)).toBe(before.pdc);
    expect(await tableCount(db, s.productBatches, companyId)).toBe(before.batches);
    expect((await db.select().from(s.docBatchUsage).where(eq(s.docBatchUsage.companyId, companyId))).length).toBe(before.lineage);
    expect(await tableCount(db, s.bundleComponents, companyId)).toBe(before.bundles);
    expect(await tableCount(db, s.setoffAllocations, companyId)).toBe(before.setoff);
    // Batch qty survived the round trip.
    const b = await db
      .select({ qty: s.productBatches.qtyThousandths })
      .from(s.productBatches)
      .where(eq(s.productBatches.id, batchId))
      .limit(1);
    expect(b[0].qty).toBe(parseQty("60"));
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });

  it("FKs are RESTRICT — no silent cascade on products or parties", async () => {
    // Product with a batch: hard delete must fail, batch must survive.
    const err1 = await db.delete(s.products).where(eq(s.products.id, productId)).catch((e) => e);
    expect(isForeignKeyViolation(err1)).toBe(true);
    expect(await tableCount(db, s.productBatches, companyId)).toBe(1);

    // Party with a PDC: hard delete must fail, PDC must survive.
    const err2 = await db.delete(s.parties).where(eq(s.parties.id, customerId)).catch((e) => e);
    expect(isForeignKeyViolation(err2)).toBe(true);
    expect(await tableCount(db, s.pdcCheques, companyId)).toBe(1);
  });

  it("full company wipe deletes child-before-parent without FK errors", async () => {
    await db.transaction(async (tx) => {
      await deleteCompanyData(tx, companyId);
    });
    for (const t of [s.pdcCheques, s.productBatches, s.bundleComponents, s.setoffAllocations,
                     s.salesDocs, s.purchaseDocs, s.journalEntries, s.parties, s.products]) {
      expect(await tableCount(db, t, companyId)).toBe(0);
    }
    expect((await db.select().from(s.docBatchUsage).where(eq(s.docBatchUsage.companyId, companyId))).length).toBe(0);
    const co = await db.select().from(s.companies).where(eq(s.companies.id, companyId)).limit(1);
    expect(co.length).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B3 — split document sequences
// ═══════════════════════════════════════════════════════════════════════════
describe("B3 — split return sequences", () => {
  let db: TestDb;
  let cleanup: () => void;
  let companyId: string;

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    companyId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: companyId, name: "Seq Co", businessType: "WHOLESALE" });
    await setupCompany(db, companyId);
  });

  afterAll(() => cleanup());

  it("sales returns draw SR- from SALE_RETURN, purchase returns PR- from PURCHASE_RETURN", async () => {
    await db.transaction(async (tx) => {
      expect(await nextDocNo(tx, companyId, "SALE_RETURN")).toBe("SR-0001");
      expect(await nextDocNo(tx, companyId, "SALE_RETURN")).toBe("SR-0002");
      expect(await nextDocNo(tx, companyId, "PURCHASE_RETURN")).toBe("PR-0001");
      expect(await nextDocNo(tx, companyId, "PURCHASE_RETURN")).toBe("PR-0002");
    });
  });

  it("minting new prefixes: EXP-, TRF-, ADJ-, CN-, DN-", async () => {
    await db.transaction(async (tx) => {
      expect(await nextDocNo(tx, companyId, "EXPENSE")).toBe("EXP-0001");
      expect(await nextDocNo(tx, companyId, "TRANSFER")).toBe("TRF-0001");
      expect(await nextDocNo(tx, companyId, "STOCK_ADJUSTMENT")).toBe("ADJ-0001");
      expect(await nextDocNo(tx, companyId, "CREDIT_NOTE")).toBe("CN-0001");
      expect(await nextDocNo(tx, companyId, "DEBIT_NOTE")).toBe("DN-0001");
    });
  });

  it("SALE_RETURN continues the legacy shared RETURN sequence; PURCHASE_RETURN starts fresh", async () => {
    const legacyId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: legacyId, name: "Legacy Co", businessType: "RETAIL" });
    // Simulate a pre-existing company whose returns shared one SR- sequence.
    await db.insert(s.numberSequences).values({
      id: crypto.randomUUID(), companyId: legacyId, docType: "RETURN", lastNo: 7,
    });
    await setupCompany(db, legacyId);
    await db.transaction(async (tx) => {
      // No SR- collision with the 7 numbers the old shared sequence issued.
      expect(await nextDocNo(tx, legacyId, "SALE_RETURN")).toBe("SR-0008");
      // PR- never existed before — starts at 1.
      expect(await nextDocNo(tx, legacyId, "PURCHASE_RETURN")).toBe("PR-0001");
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B4 — direct returns write batch lineage
// ═══════════════════════════════════════════════════════════════════════════
describe("B4 — direct returns record doc_batch_usage", () => {
  let db: TestDb;
  let cleanup: () => void;
  let companyId: string, branchId: string, userId: string;
  let customerId: string, supplierId: string, productId: string;

  async function postPurchase(
    qty: string, docType: "BILL" | "RETURN", batch: { batchNo?: string | null; batchId?: string | null }
  ): Promise<string> {
    const items: DocItemInput[] = [
      { productId, description: "t", qtyMilli: parseQty(qty), ratePaisa: parseMoney("10"), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const seqType = docType === "RETURN" ? "PURCHASE_RETURN" : docType;
      const docNo = await nextDocNo(tx, companyId, seqType);
      await tx.insert(s.purchaseDocs).values({
        id: docId, companyId, branchId, partyId: supplierId, docType, docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postPurchaseDoc(tx, {
        companyId, branchId, partyId: supplierId, docId, docNo, docType, date: new Date(),
        items: totals.items.map((i) => ({
          ...i, trackStock: true, batchNo: batch.batchNo ?? null, batchId: batch.batchId ?? null,
        })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
    return docId;
  }

  async function postSale(qty: string, docType: "INVOICE" | "RETURN", batchId: string | null): Promise<string> {
    const items: DocItemInput[] = [
      { productId, description: "t", qtyMilli: parseQty(qty), ratePaisa: parseMoney("15"), discountPaisa: 0n, taxBps: 0 },
    ];
    const totals = computeTotals(items, 0n);
    const docId = crypto.randomUUID();
    await db.transaction(async (tx) => {
      const seqType = docType === "RETURN" ? "SALE_RETURN" : docType;
      const docNo = await nextDocNo(tx, companyId, seqType);
      await tx.insert(s.salesDocs).values({
        id: docId, companyId, branchId, partyId: customerId, docType, docNo,
        date: new Date(), status: "POSTED",
        subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
        createdById: userId,
      });
      await postSalesDoc(tx, {
        companyId, branchId, partyId: customerId, docId, docNo, docType, date: new Date(),
        items: totals.items.map((i) => ({ ...i, trackStock: true, batchId })),
        discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal, createdById: userId,
      });
    });
    return docId;
  }

  async function usageFor(docId: string): Promise<bigint[]> {
    const rows = await db
      .select({ q: s.docBatchUsage.qtyThousandths })
      .from(s.docBatchUsage)
      .where(and(eq(s.docBatchUsage.docId, docId), eq(s.docBatchUsage.companyId, companyId)));
    return rows.map((r) => r.q);
  }

  async function batchQty(batchNo: string): Promise<bigint> {
    const rows = await db
      .select({ q: s.productBatches.qtyThousandths })
      .from(s.productBatches)
      .where(and(eq(s.productBatches.companyId, companyId), eq(s.productBatches.batchNo, batchNo)))
      .limit(1);
    return rows[0]?.q ?? 0n;
  }

  async function batchIdFor(batchNo: string): Promise<string> {
    const rows = await db
      .select({ id: s.productBatches.id })
      .from(s.productBatches)
      .where(and(eq(s.productBatches.companyId, companyId), eq(s.productBatches.batchNo, batchNo)))
      .limit(1);
    return rows[0].id;
  }

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    companyId = crypto.randomUUID();
    userId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: companyId, name: "Lineage Co", businessType: "WHOLESALE" });
    ({ branchId } = await setupCompany(db, companyId));
    customerId = crypto.randomUUID();
    supplierId = crypto.randomUUID();
    await db.insert(s.parties).values([
      { id: customerId, companyId, name: "C1", kind: "CUSTOMER", balance: 0n },
      { id: supplierId, companyId, name: "S1", kind: "SUPPLIER", balance: 0n },
    ]);
    productId = crypto.randomUUID();
    await db.insert(s.products).values({
      id: productId, companyId, sku: "GADGET-1", name: "Gadget", trackStock: true,
      purchasePrice: parseMoney("10"), salePrice: parseMoney("15"),
    });
  });

  afterAll(() => cleanup());

  it("direct purchase RETURN with a batchId writes a negative usage row", async () => {
    await postPurchase("50", "BILL", { batchNo: "PB1" });
    const bid = await batchIdFor("PB1");
    const retId = await postPurchase("10", "RETURN", { batchId: bid });
    const usage = await usageFor(retId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toBe(-parseQty("10")); // purchase-return convention: negative
    expect(await batchQty("PB1")).toBe(parseQty("40"));
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });

  it("direct sales RETURN with a batchId writes a positive usage row", async () => {
    const bid = await batchIdFor("PB1");
    await postSale("5", "INVOICE", bid);
    const retId = await postSale("2", "RETURN", bid);
    const usage = await usageFor(retId);
    expect(usage).toHaveLength(1);
    expect(usage[0]).toBe(parseQty("2")); // sales-return convention: positive
    expect(await batchQty("PB1")).toBe(parseQty("37")); // 40 − 5 + 2
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B5 — expense doc numbers
// ═══════════════════════════════════════════════════════════════════════════
describe("B5 — expense docNo", () => {
  let db: TestDb;
  let cleanup: () => void;
  let companyId: string, branchId: string, userId: string, cashId: string, expAcctId: string;

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    companyId = crypto.randomUUID();
    userId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: companyId, name: "Expense Co", businessType: "SERVICES" });
    ({ branchId } = await setupCompany(db, companyId));
    // setupCompany seeds a CASH bank account (linked to a GL account); reuse it.
    cashId = (
      await db
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0].id;
    expAcctId = crypto.randomUUID();
    await db.insert(s.accounts).values({ id: expAcctId, companyId, code: "6001", name: "Shop Rent", type: "EXPENSE" });
  });

  afterAll(() => cleanup());

  it("postExpense mints EXP-0001, EXP-0002 when docNo is omitted", async () => {
    const mk = (amt: string) =>
      db.transaction((tx) =>
        postExpense(tx, {
          companyId, branchId, accountId: expAcctId, bankAccountId: cashId,
          date: new Date(), amount: parseMoney(amt), taxAmount: 0n, createdById: userId,
        })
      );
    const id1 = await mk("100");
    const id2 = await mk("200");
    const rows = await db
      .select({ id: s.expenses.id, docNo: s.expenses.docNo })
      .from(s.expenses)
      .where(eq(s.expenses.companyId, companyId));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r.docNo]));
    expect(byId[id1]).toBe("EXP-0001");
    expect(byId[id2]).toBe("EXP-0002");
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });

  it("migration 0024 backfilled doc_no for pre-existing expenses", async () => {
    const legacyId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: legacyId, name: "Legacy Exp Co", businessType: "RETAIL" });
    // Simulate a row that predates the doc_no column (raw SQL, doc_no NULL),
    // then run the exact backfill UPDATE from migration 0024.
    const now = Date.now();
    const client = (
      db as unknown as { $client: { execute: (q: string | { sql: string; args: unknown[] }) => Promise<unknown> } }
    ).$client;
    await client.execute({
      sql: "INSERT INTO expenses (id, company_id, branch_id, account_id, bank_account_id, date, amount, tax_amount, notes, created_by_id, created_at, doc_no) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
      args: [crypto.randomUUID(), legacyId, branchId, expAcctId, cashId, now, 1000, 0, null, userId, now, null],
    });
    await client.execute(`UPDATE expenses SET doc_no = (
      SELECT printf('EXP-%04d', sub.rn)
      FROM (
        SELECT e2.id AS id,
               ROW_NUMBER() OVER (
                 PARTITION BY e2.company_id
                 ORDER BY e2.date, e2.created_at, e2.id
               ) AS rn
        FROM expenses e2
      ) AS sub
      WHERE sub.id = expenses.id
    ) WHERE doc_no IS NULL`);
    const rows = await db
      .select({ docNo: s.expenses.docNo })
      .from(s.expenses)
      .where(eq(s.expenses.companyId, legacyId));
    expect(rows).toHaveLength(1);
    expect(rows[0].docNo).toMatch(/^EXP-\d{4}$/);
  });
});
// ═══════════════════════════════════════════════════════════════════════════
// B2 / B5-route / B6 — real Next route handlers with mocked auth
// ═══════════════════════════════════════════════════════════════════════════
describe("route-level: PDC actions, expense docNo, payment 422s", () => {
  let routeDb: TestDb;
  let branchId: string, customerId: string, supplierId: string, bankId: string;
  let pdcRoute: typeof import("@/app/api/pdc/[id]/[action]/route");
  let paymentsRoute: typeof import("@/app/api/payments/route");
  let expensesRoute: typeof import("@/app/api/expenses/route");

    async function reqJson(url: string, body: unknown) {
    const { NextRequest } = await import("next/server");
    return new NextRequest(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function makePdc(kind: "RECEIVED" | "ISSUED", partyId: string): Promise<string> {
    let id = "";
    await routeDb.transaction(async (tx: DbTx) => {
      id = await recordPdc(tx, {
        companyId: hoisted.cid, branchId, kind, partyId,
        chequeNo: "CHQ-" + crypto.randomUUID().slice(0, 8),
        amount: parseMoney("1000"), chequeDate: new Date(), createdById: hoisted.uid,
      });
    });
    return id;
  }

  async function pdcStatus(id: string): Promise<string> {
    const rows = await routeDb.select({ st: s.pdcCheques.status }).from(s.pdcCheques).where(eq(s.pdcCheques.id, id)).limit(1);
    return rows[0].st;
  }

  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    pdcRoute = await import("@/app/api/pdc/[id]/[action]/route");
    paymentsRoute = await import("@/app/api/payments/route");
    expensesRoute = await import("@/app/api/expenses/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "Route Co", businessType: "WHOLESALE" });
    ({ branchId } = await setupCompany(routeDb, hoisted.cid));
    customerId = crypto.randomUUID();
    supplierId = crypto.randomUUID();
    await routeDb.insert(s.parties).values([
      { id: customerId, companyId: hoisted.cid, name: "RC", kind: "CUSTOMER", balance: 0n },
      { id: supplierId, companyId: hoisted.cid, name: "RS", kind: "SUPPLIER", balance: 0n },
    ]);
    bankId = (
      await routeDb
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, hoisted.cid), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0].id;
  }, 60000);

  // ── B2 ────────────────────────────────────────────────────────────────
  it("B2: POST /api/pdc/{id}/clear clears a received cheque and balances", async () => {
    const id = await makePdc("RECEIVED", customerId);
    const req = await reqJson(`http://x/api/pdc/${id}/clear`, { bankAccountId: bankId, date: "2026-09-30" });
    const res = await pdcRoute.POST(req, { params: Promise.resolve({ id, action: "clear" }) });
    expect(res.status).toBe(200);
    expect(await pdcStatus(id)).toBe("CLEARED");
    expect(await trialBalanceZero(routeDb, hoisted.cid)).toBe(true);
  });

  it("B2: POST /api/pdc/{id}/bounce bounces and restores the party balance", async () => {
    const before = (await routeDb.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0].b;
    const id = await makePdc("RECEIVED", customerId);
    const req = await reqJson(`http://x/api/pdc/${id}/bounce`, { date: "2026-09-30", reason: "NSF" });
    const res = await pdcRoute.POST(req, { params: Promise.resolve({ id, action: "bounce" }) });
    expect(res.status).toBe(200);
    expect(await pdcStatus(id)).toBe("BOUNCED");
    const after = (await routeDb.select({ b: s.parties.balance }).from(s.parties).where(eq(s.parties.id, customerId)).limit(1))[0].b;
    expect(after).toBe(before);
    expect(await trialBalanceZero(routeDb, hoisted.cid)).toBe(true);
  });

  it("B2: POST /api/pdc/{id}/cancel cancels an issued cheque", async () => {
    const id = await makePdc("ISSUED", supplierId);
    const req = await reqJson(`http://x/api/pdc/${id}/cancel`, { date: "2026-09-30" });
    const res = await pdcRoute.POST(req, { params: Promise.resolve({ id, action: "cancel" }) });
    expect(res.status).toBe(200);
    expect(await pdcStatus(id)).toBe("CANCELLED");
    expect(await trialBalanceZero(routeDb, hoisted.cid)).toBe(true);
  });

  it("B2: unknown action → 404", async () => {
    const id = await makePdc("RECEIVED", customerId);
    const req = await reqJson(`http://x/api/pdc/${id}/explode`, {});
    const res = await pdcRoute.POST(req, { params: Promise.resolve({ id, action: "explode" }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown action/);
    expect(await pdcStatus(id)).toBe("PENDING");
  });

  it("B2: clearing an already-cleared cheque is rejected, not double-posted", async () => {
    const id = await makePdc("RECEIVED", customerId);
    const url = (a: string) => `http://x/api/pdc/${id}/${a}`;
    const r1 = await pdcRoute.POST(await reqJson(url("clear"), { bankAccountId: bankId, date: "2026-09-30" }), { params: Promise.resolve({ id, action: "clear" }) });
    expect(r1.status).toBe(200);
    const r2 = await pdcRoute.POST(await reqJson(url("clear"), { bankAccountId: bankId, date: "2026-09-30" }), { params: Promise.resolve({ id, action: "clear" }) });
    expect(r2.status).not.toBe(200);
    expect(await trialBalanceZero(routeDb, hoisted.cid)).toBe(true);
  });

  // ── B5 (route) ────────────────────────────────────────────────────────
  it("B5: POST /api/expenses returns the minted EXP- docNo", async () => {
    const acct = (
      await routeDb
        .select({ id: s.accounts.id })
        .from(s.accounts)
        .where(and(eq(s.accounts.companyId, hoisted.cid), eq(s.accounts.code, "6000")))
        .limit(1)
    )[0].id;
    const mk = async () => {
      const req = await reqJson("http://x/api/expenses", {
        accountId: acct, bankAccountId: bankId, date: "2026-09-30", amount: "50",
      });
      return expensesRoute.POST(req);
    };
    const r1 = await mk();
    expect(r1.status).toBe(201);
    const b1 = await r1.json();
    expect(b1.data.docNo).toBe("EXP-0001");
    const r2 = await mk();
    const b2 = await r2.json();
    expect(b2.data.docNo).toBe("EXP-0002");
  });

  // ── B6 ────────────────────────────────────────────────────────────────
  it("B6: POST /api/payments without a party → 422, not 500", async () => {
    const req = await reqJson("http://x/api/payments", {
      kind: "RECEIPT", bankAccountId: bankId, date: "2026-09-30", amount: "100",
    });
    const res = await paymentsRoute.POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/customer or supplier/);
  });

  it("B6: POST /api/payments with an invalid party → 422, not 500", async () => {
    const req = await reqJson("http://x/api/payments", {
      kind: "RECEIPT", partyId: crypto.randomUUID(), bankAccountId: bankId,
      date: "2026-09-30", amount: "100",
    });
    const res = await paymentsRoute.POST(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toMatch(/invalid/);
  });
});
