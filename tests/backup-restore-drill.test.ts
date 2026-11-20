/**
 * Phase 4 backup/restore DRILL.
 *
 * Unlike tests/backup-restore.test.ts (same-DB round trip), this drills
 * the disaster case: the books live ONLY in a backup file, and the
 * company shell is empty. A backup is built from a rich company in one
 * fresh DB, then restored into a SECOND fresh DB that holds nothing but
 * the company row — and the rebuilt books must match the original,
 * section by section. It also proves a tampered payload restores nothing.
 *
 * Run it with: sh scripts/backup-restore-drill.sh
 * It never touches production: both DBs are temp files, deleted after.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import {
  buildBackupPayload,
  serializeBackup,
  validateBackupPayload,
  BACKUP_ARRAY_KEYS,
} from "@/lib/backup";
import {
  assertSameCompany,
  restoreCompanyData,
} from "@/lib/restore";
import { UserError } from "@/lib/errors";
import { getTableColumns } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import * as s from "@/db/schema";

let db1: TestDb;
let db2: TestDb;
let cleanup1: () => void;
let cleanup2: () => void;

beforeAll(async () => {
  ({ db: db1, cleanup: cleanup1 } = await createTestDb());
  ({ db: db2, cleanup: cleanup2 } = await createTestDb());
});

afterAll(() => {
  cleanup1();
  cleanup2();
});

const uid = () => crypto.randomUUID();

async function makeCompany(db: TestDb, name: string) {
  const cid = uid();
  await db.insert(s.companies).values({ id: cid, name });
  const userId = uid();
  await db.insert(s.users).values({ id: userId, companyId: cid, name: "Owner", email: `${uid()}@x.test`, passwordHash: "h", role: "OWNER" });
  const branchId = uid();
  await db.insert(s.branches).values({ id: branchId, companyId: cid, name: "Main", isDefault: true });
  const cashGl = uid();
  await db.insert(s.accounts).values({ id: cashGl, companyId: cid, code: "1001", name: "Cash", type: "ASSET" });
  const expGl = uid();
  await db.insert(s.accounts).values({ id: expGl, companyId: cid, code: "6000", name: "Rent", type: "EXPENSE" });
  const partyId = uid();
  await db.insert(s.parties).values({ id: partyId, companyId: cid, kind: "CUSTOMER", name: "Drill Customer", balance: 602550n });
  const productId = uid();
  await db.insert(s.products).values({ id: productId, companyId: cid, sku: "SKU-1", name: "Drill Product", purchasePrice: 10000n, salePrice: 15000n });
  const bankId = uid();
  await db.insert(s.bankAccounts).values({ id: bankId, companyId: cid, name: "Cash Box", kind: "CASH", accountId: cashGl, balance: 50000n });
  const saleId = uid();
  await db.insert(s.salesDocs).values({ id: saleId, companyId: cid, branchId, partyId, docType: "INVOICE", docNo: "S-1", date: new Date("2026-01-05T12:00:00Z"), grandTotal: 15000n, createdById: userId });
  await db.insert(s.salesDocItems).values({ id: uid(), docId: saleId, productId, description: "Drill Product", qty: 1000n, rate: 15000n, lineTotal: 15000n });
  const purchId = uid();
  await db.insert(s.purchaseDocs).values({ id: purchId, companyId: cid, branchId, partyId, docType: "BILL", docNo: "P-1", date: new Date("2026-01-04T12:00:00Z"), grandTotal: 10000n, createdById: userId });
  await db.insert(s.purchaseDocItems).values({ id: uid(), docId: purchId, productId, description: "Drill Product", qty: 1000n, rate: 10000n, lineTotal: 10000n });
  const payId = uid();
  await db.insert(s.payments).values({ id: payId, companyId: cid, branchId, kind: "RECEIPT", date: new Date("2026-01-06T12:00:00Z"), partyId, bankAccountId: bankId, amount: 5000n, createdById: userId });
  await db.insert(s.paymentAllocations).values({ id: uid(), paymentId: payId, partyId, salesDocId: saleId, amount: 5000n });
  await db.insert(s.expenses).values({ id: uid(), companyId: cid, branchId, date: new Date("2026-01-07T12:00:00Z"), accountId: expGl, bankAccountId: bankId, amount: 2000n, createdById: userId });
  const jeId = uid();
  await db.insert(s.journalEntries).values({ id: jeId, companyId: cid, branchId, date: new Date("2026-01-07T12:00:00Z"), memo: "Drill entry", source: "MANUAL", createdById: userId });
  await db.insert(s.journalLines).values({ id: uid(), entryId: jeId, accountId: expGl, debit: 2000n, credit: 0n });
  await db.insert(s.journalLines).values({ id: uid(), entryId: jeId, accountId: cashGl, debit: 0n, credit: 2000n });
  await db.insert(s.stockLevels).values({ id: uid(), productId, branchId, qty: 1000n, avgCost: 10000n });
  await db.insert(s.numberSequences).values({ id: uid(), companyId: cid, docType: "INVOICE", prefix: "S-", lastNo: 1 });
  return { cid, userId, partyId, productId, saleId };
}

const SECTION_TABLES: Record<(typeof BACKUP_ARRAY_KEYS)[number], SQLiteTable> = {
  branches: s.branches,
  accounts: s.accounts,
  parties: s.parties,
  creditHoldEvents: s.creditHoldEvents,
  products: s.products,
  bankAccounts: s.bankAccounts,
  salesDocs: s.salesDocs,
  salesDocItems: s.salesDocItems,
  purchaseDocs: s.purchaseDocs,
  purchaseDocItems: s.purchaseDocItems,
  payments: s.payments,
  paymentAllocations: s.paymentAllocations,
  expenses: s.expenses,
  journalEntries: s.journalEntries,
  journalLines: s.journalLines,
  stockLevels: s.stockLevels,
  numberSequences: s.numberSequences,
  recurringTemplates: s.recurringTemplates,
  recurringTemplateLines: s.recurringTemplateLines,
  recurringRuns: s.recurringRuns,
  ipAllowlist: s.ipAllowlist,
  loginAttempts: s.loginAttempts,
};

async function sectionCounts(db: TestDb, cid: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const key of BACKUP_ARRAY_KEYS) {
    const table = SECTION_TABLES[key];
    const cols = getTableColumns(table);
    // Company-scoped tables count only this company's rows; line/child
    // tables (no companyId) count whole-table — each drill DB holds one
    // company's books at a time, so the comparison still holds.
    const rows =
      "companyId" in cols
        ? await db.select({ id: cols.id }).from(table).where(eq(cols.companyId, cid))
        : await db.select({ id: cols.id }).from(table);
    out[key] = rows.length;
  }
  return out;
}

describe("backup/restore drill — rebuild from file alone", () => {
  it("a backup file rebuilds the books in an empty company shell", async () => {
    const { cid, partyId, productId, saleId } = await makeCompany(db1, "Drill Co");
    const { payload } = await buildBackupPayload(db1, cid);
    const raw = serializeBackup(payload);
    expect(validateBackupPayload(raw).ok).toBe(true);

    const before = await sectionCounts(db1, cid);

    // Empty shell in DB2: only the company row exists (the restore UI
    // always runs inside a logged-in company, so the shell exists).
    await db2.insert(s.companies).values({ id: cid, name: "Drill Co" });
    expect(await sectionCounts(db2, cid)).toMatchObject({ parties: 0, salesDocs: 0 });

    const doc = JSON.parse(raw) as Parameters<typeof restoreCompanyData>[2];
    assertSameCompany(doc, cid);
    const counts = await db2.transaction(async (tx) => restoreCompanyData(tx, cid, doc));
    expect(counts.parties).toBe(1);
    expect(counts.salesDocs).toBe(1);

    const after = await sectionCounts(db2, cid);
    expect(after).toEqual(before);

    // Spot-check values, not just counts: money must come back exact.
    const party = (await db2.select().from(s.parties).where(eq(s.parties.id, partyId)).limit(1))[0];
    expect(party.balance).toBe(602550n);
    const product = (await db2.select().from(s.products).where(eq(s.products.id, productId)).limit(1))[0];
    expect(product.salePrice).toBe(15000n);
    const sale = (await db2.select().from(s.salesDocs).where(eq(s.salesDocs.id, saleId)).limit(1))[0];
    expect(sale.grandTotal).toBe(15000n);
    expect(sale.docNo).toBe("S-1");
  });

  it("a wrong-company backup is rejected before any write to the shell", async () => {
    const { cid } = await makeCompany(db1, "Drill Co 2");
    const { payload } = await buildBackupPayload(db1, cid);
    const raw = serializeBackup(payload);
    const doc = JSON.parse(raw) as Parameters<typeof restoreCompanyData>[2];
    expect(() => assertSameCompany(doc, "some-other-company")).toThrow(UserError);
    // The shell is untouched: no parties were created by the rejected doc.
    const rows = await db2.select().from(s.parties).where(eq(s.parties.companyId, "some-other-company"));
    expect(rows).toHaveLength(0);
  });

  it("a tampered payload restores nothing (transaction rolls back)", async () => {
    const { cid } = await makeCompany(db1, "Drill Co 3");
    const { payload } = await buildBackupPayload(db1, cid);
    const doc = JSON.parse(serializeBackup(payload)) as Record<string, unknown>;
    (doc.parties as Record<string, unknown>[])[0].id = "";
    await db2.insert(s.companies).values({ id: cid, name: "Drill Co 3" });
    await expect(
      db2.transaction(async (tx) => restoreCompanyData(tx, cid, doc as Parameters<typeof restoreCompanyData>[2]))
    ).rejects.toThrow();
    const rows = await db2.select().from(s.parties).where(eq(s.parties.companyId, cid));
    expect(rows).toHaveLength(0);
  });
});
