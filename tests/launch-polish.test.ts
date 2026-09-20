import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, isNull } from "drizzle-orm";
import { getTableColumns, type Column } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { hasRecoveryCode } from "@/lib/recovery";
import { hashPassword } from "@/lib/auth";
import {
  validateSupportInput,
  createSupportRequest,
  listSupportRequests,
  setSupportRequestStatus,
  SUPPORT_SETTING_KEYS,
} from "@/lib/support";
import { CHANGELOG } from "@/lib/changelog";
import { PERIOD_LOCK_GUIDANCE } from "@/lib/period-guidance";
import { deleteCompanyData, companyScopedTables } from "@/lib/company-delete";
import { setupCompany } from "@/lib/setup";
import { isPlatformAdminEmail } from "@/lib/billing-guards";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function makeUser(companyId: string, email: string, withCode: boolean): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.users).values({
    id, companyId, name: "Test User", email,
    passwordHash: await hashPassword("password123"),
    role: "OWNER",
    recoveryCodeHash: withCode ? await hashPassword("ABCDEFGHJKLMNPQR") : null,
  });
  return id;
}

describe("recovery-status", () => {
  it("hasRecoveryCode is true only when a code hash is stored", async () => {
    const cid = crypto.randomUUID();
    await db.insert(s.companies).values({ id: cid, name: "Recovery Co" });
    const withCode = await makeUser(cid, "with-code@example.com", true);
    const withoutCode = await makeUser(cid, "without-code@example.com", false);
    expect(await hasRecoveryCode(db, withCode)).toBe(true);
    expect(await hasRecoveryCode(db, withoutCode)).toBe(false);
    expect(await hasRecoveryCode(db, crypto.randomUUID())).toBe(false);
  });
});

describe("support requests", () => {
  it("validates the public form input", () => {
    const good = validateSupportInput({
      name: "Ahmed Khan", email: "ahmed@example.com",
      subject: "POS is slow", message: "The POS screen takes very long to load on my phone.",
    });
    expect(good.email).toBe("ahmed@example.com");
    expect(() => validateSupportInput({ name: "A", email: "a@b.co", subject: "Hi!", message: "long enough message here" }))
      .toThrowError(UserError);
    expect(() => validateSupportInput({ name: "Ahmed", email: "not-an-email", subject: "Hi!", message: "long enough message here" }))
      .toThrowError(/valid email/i);
    expect(() => validateSupportInput({ name: "Ahmed", email: "a@b.co", subject: "Hi", message: "long enough message here" }))
      .toThrowError(/subject/i);
    expect(() => validateSupportInput({ name: "Ahmed", email: "a@b.co", subject: "Hello there", message: "short" }))
      .toThrowError(/10–4000/);
  });

  it("creates, lists and resolves requests", async () => {
    const id = await createSupportRequest(db, {
      name: "Sara", email: "sara@example.com", subject: "Billing question", message: "How do I pay for PRO?",
    });
    expect(id).toBeTruthy();
    const open = await listSupportRequests(db, "OPEN");
    expect(open.some((r) => r.id === id)).toBe(true);
    expect(open[0].createdAt.getTime()).toBeGreaterThanOrEqual(open[open.length - 1].createdAt.getTime());

    expect(await setSupportRequestStatus(db, id, "RESOLVED")).toBe(true);
    expect(await setSupportRequestStatus(db, crypto.randomUUID(), "RESOLVED")).toBe(false);
    const resolved = await listSupportRequests(db, "RESOLVED");
    expect(resolved.some((r) => r.id === id)).toBe(true);
    const stillOpen = await listSupportRequests(db, "OPEN");
    expect(stillOpen.some((r) => r.id === id)).toBe(false);
    const all = await listSupportRequests(db, "ALL");
    expect(all.some((r) => r.id === id)).toBe(true);
  });

  it("support setting keys are a fixed known set", () => {
    expect([...SUPPORT_SETTING_KEYS]).toEqual(["support.email", "support.phone", "support.hours"]);
  });

  it("platform admin gate reads PLATFORM_ADMIN_EMAILS", () => {
    process.env.PLATFORM_ADMIN_EMAILS = "admin@example.com, second@example.com";
    expect(isPlatformAdminEmail("admin@example.com")).toBe(true);
    expect(isPlatformAdminEmail("ADMIN@EXAMPLE.COM")).toBe(true);
    expect(isPlatformAdminEmail("stranger@example.com")).toBe(false);
    delete process.env.PLATFORM_ADMIN_EMAILS;
    expect(isPlatformAdminEmail("admin@example.com")).toBe(false);
  });
});

describe("changelog", () => {
  it("has seeded entries, newest first, with verifiable tags", () => {
    expect(CHANGELOG.length).toBeGreaterThan(5);
    for (const e of CHANGELOG) {
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.tag).toMatch(/^[0-9a-f]{7}$/);
      expect(e.title.length).toBeGreaterThan(3);
      expect(e.bullets.length).toBeGreaterThan(0);
    }
    const dates = CHANGELOG.map((e) => e.date);
    const sorted = [...dates].sort().reverse();
    expect(dates).toEqual(sorted);
    // Key shipped batches are present (tags verifiable via `git show <tag>`)
    const tags = new Set(CHANGELOG.map((e) => e.tag));
    for (const t of ["8a85535", "829fa75", "21b9eca", "35f4452"]) {
      expect(tags.has(t)).toBe(true);
    }
  });
});

describe("period-lock guidance", () => {
  it("explains the lock in plain language", () => {
    const text = PERIOD_LOCK_GUIDANCE.join(" ").toLowerCase();
    for (const topic of ["sales", "purchases", "payments", "expenses", "pos", "set-off", "drafts", "return"]) {
      expect(text).toContain(topic);
    }
    expect(text).toContain("year-month-day"); // expected date format
    expect(text).toContain("future"); // future dates rejected
    expect(text).toContain("clear"); // how clearing works
    expect(text).toContain("owner"); // owner-only
  });
});

describe("company deletion", () => {
  it("discovers every company-scoped table from the schema", () => {
    const tables = companyScopedTables();
    expect(tables.length).toBeGreaterThan(10);
    // spot-check the important ones are covered
    for (const t of [s.users, s.parties, s.products, s.salesDocs, s.purchaseDocs, s.payments, s.expenses,
      s.journalEntries, s.accounts, s.bankAccounts, s.branches, s.billingPayments, s.auditLogs, s.settings]) {
      expect(tables).toContain(t);
    }
    // global tables must NOT be wiped
    expect(tables).not.toContain(s.platformSettings);
    expect(tables).not.toContain(s.rateLimits);
    expect(tables).not.toContain(s.supportRequests);
  });

  it("removes every row of the company in one transaction and leaves others alone", async () => {
    const cid = crypto.randomUUID();
    const otherCid = crypto.randomUUID();
    await db.insert(s.companies).values({ id: cid, name: "Delete Me Co" });
    await db.insert(s.companies).values({ id: otherCid, name: "Survivor Co" });
    const { branchId } = await setupCompany(db, cid);
    await setupCompany(db, otherCid);
    const uid = crypto.randomUUID();
    await db.insert(s.users).values({
      id: uid, companyId: cid, name: "Owner", email: "del-owner@example.com",
      passwordHash: await hashPassword("password123"), role: "OWNER",
    });
    const partyId = crypto.randomUUID();
    await db.insert(s.parties).values({ id: partyId, companyId: cid, kind: "CUSTOMER", name: "P" });
    const productId = crypto.randomUUID();
    await db.insert(s.products).values({
      id: productId, companyId: cid, sku: "DEL-1", name: "Prod", unit: "PCS",
      purchasePrice: 100n, salePrice: 150n, trackStock: false,
    });
    const branchRows = await db.select().from(s.branches).where(eq(s.branches.companyId, cid)).limit(1);
    await db.insert(s.stockLevels).values({
      id: crypto.randomUUID(), productId, branchId: branchRows[0].id, qty: 1000n, avgCost: 100n,
    });
    const saleId = crypto.randomUUID();
    await db.insert(s.salesDocs).values({
      id: saleId, companyId: cid, branchId, partyId, docType: "INVOICE", docNo: "S-1",
      date: new Date(), status: "POSTED", grandTotal: 100n, createdById: uid,
    });
    await db.insert(s.salesDocItems).values({
      id: crypto.randomUUID(), docId: saleId, description: "Prod", qty: 1000n, rate: 100n, lineTotal: 100n,
    });
    const purchId = crypto.randomUUID();
    await db.insert(s.purchaseDocs).values({
      id: purchId, companyId: cid, branchId, partyId, docType: "BILL", docNo: "P-1",
      date: new Date(), status: "POSTED", grandTotal: 100n, createdById: uid,
    });
    await db.insert(s.purchaseDocItems).values({
      id: crypto.randomUUID(), docId: purchId, description: "Prod", qty: 1000n, rate: 100n, lineTotal: 100n,
    });
    const acctRows = await db.select().from(s.accounts).where(eq(s.accounts.companyId, cid)).limit(1);
    const jeId = crypto.randomUUID();
    await db.insert(s.journalEntries).values({
      id: jeId, companyId: cid, branchId, date: new Date(), memo: "test", source: "MANUAL", createdById: uid,
    });
    await db.insert(s.journalLines).values({
      id: crypto.randomUUID(), entryId: jeId, accountId: acctRows[0].id, debit: 100n, credit: 0n,
    });
    const payId = crypto.randomUUID();
    await db.insert(s.payments).values({
      id: payId, companyId: cid, branchId, kind: "RECEIPT", date: new Date(),
      partyId, bankAccountId: crypto.randomUUID(), amount: 100n, method: "CASH", createdById: uid,
    });
    await db.insert(s.paymentAllocations).values({
      id: crypto.randomUUID(), paymentId: payId, partyId, salesDocId: saleId, amount: 100n,
    });
    await db.insert(s.expenses).values({
      id: crypto.randomUUID(), companyId: cid, branchId, date: new Date(),
      accountId: acctRows[0].id, bankAccountId: crypto.randomUUID(), amount: 50n, createdById: uid,
    });
    await db.insert(s.heldBills).values({
      id: crypto.randomUUID(), companyId: cid, userId: uid, label: "hold", lines: "[]",
    });
    await db.insert(s.settings).values({ id: crypto.randomUUID(), companyId: cid, key: "k", value: "v" });
    await db.insert(s.billingPayments).values({
      id: crypto.randomUUID(), companyId: cid, userId: uid, amountPaisa: 150000,
      method: "BANK", reference: "REF1",
    });
    await db.insert(s.auditLogs).values({
      id: crypto.randomUUID(), companyId: cid, userId: uid, userName: "Owner",
      action: "test.action",
    });
    await db.insert(s.errorLogs).values({
      id: crypto.randomUUID(), companyId: cid, route: "/x", message: "company log",
    });
    // The route's pre-delete audit entry (companyId NULL) must survive the wipe.
    await db.insert(s.errorLogs).values({
      id: crypto.randomUUID(), companyId: null, route: "/api/company",
      message: `company.deleted id=${cid} name=Delete Me Co`,
    });
    // Another company's rows must survive.
    await db.insert(s.parties).values({ id: crypto.randomUUID(), companyId: otherCid, kind: "CUSTOMER", name: "Other" });

    await db.transaction((tx) => deleteCompanyData(tx, cid));

    // Every company-scoped table: zero rows for the deleted company.
    for (const table of companyScopedTables()) {
      const cols = getTableColumns(table) as Record<string, Column>;
      const col = Object.values(cols).find((c) => c.name === "company_id")!;
      const rows = await db.select().from(table).where(eq(col, cid)).limit(1);
      expect(rows.length, `table with company_id`).toBe(0);
    }
    // Indirect children are gone too.
    expect(await db.select().from(s.salesDocItems).where(eq(s.salesDocItems.docId, saleId))).toEqual([]);
    expect(await db.select().from(s.purchaseDocItems).where(eq(s.purchaseDocItems.docId, purchId))).toEqual([]);
    expect(await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, jeId))).toEqual([]);
    expect(await db.select().from(s.paymentAllocations).where(eq(s.paymentAllocations.paymentId, payId))).toEqual([]);
    expect(await db.select().from(s.stockLevels).where(eq(s.stockLevels.productId, productId))).toEqual([]);
    // Company row itself is gone.
    expect(await db.select().from(s.companies).where(eq(s.companies.id, cid))).toEqual([]);
    // The global audit entry survived.
    const survived = await db.select().from(s.errorLogs)
      .where(and(eq(s.errorLogs.route, "/api/company"), isNull(s.errorLogs.companyId)));
    expect(survived.some((r) => r.message.includes(`company.deleted id=${cid}`))).toBe(true);
    // Other company's data untouched.
    const otherParties = await db.select().from(s.parties).where(eq(s.parties.companyId, otherCid));
    expect(otherParties.length).toBe(1);
    const otherCompanies = await db.select().from(s.companies).where(eq(s.companies.id, otherCid));
    expect(otherCompanies.length).toBe(1);
  });
});
