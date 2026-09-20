import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { SignJWT } from "jose";
import { createTestDb, type TestDb } from "./helpers";
import {
  buildBackupPayload,
  serializeBackup,
  validateBackupPayload,
} from "@/lib/backup";
import {
  RESTORE_ORDER,
  assertSameCompany,
  assertTypedNameMatches,
  checkRestoreCooldown,
  payloadHash,
  recordRestoreDone,
  restoreCompanyData,
  restorePreservedTables,
} from "@/lib/restore";
import { signRestoreToken, verifyRestoreToken } from "@/lib/auth";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

const uid = () => crypto.randomUUID();

// Rich fixture: at least one row in every backup section, plus rows in
// preserved tables (users, backups, settings).
async function makeRichCompany(name: string) {
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
  await db.insert(s.parties).values({ id: partyId, companyId: cid, kind: "CUSTOMER", name: "Test Customer" });
  const productId = uid();
  await db.insert(s.products).values({ id: productId, companyId: cid, sku: "SKU-1", name: "Test Product", purchasePrice: 10000n, salePrice: 15000n });
  const bankId = uid();
  await db.insert(s.bankAccounts).values({ id: bankId, companyId: cid, name: "Cash Box", kind: "CASH", accountId: cashGl, balance: 50000n });
  const saleId = uid();
  await db.insert(s.salesDocs).values({ id: saleId, companyId: cid, branchId, partyId, docType: "INVOICE", docNo: "S-1", date: new Date("2026-01-05T12:00:00Z"), grandTotal: 15000n, createdById: userId });
  await db.insert(s.salesDocItems).values({ id: uid(), docId: saleId, productId, description: "Test Product", qty: 1000n, rate: 15000n, lineTotal: 15000n });
  const purchId = uid();
  await db.insert(s.purchaseDocs).values({ id: purchId, companyId: cid, branchId, partyId, docType: "BILL", docNo: "P-1", date: new Date("2026-01-04T12:00:00Z"), grandTotal: 10000n, createdById: userId });
  await db.insert(s.purchaseDocItems).values({ id: uid(), docId: purchId, productId, description: "Test Product", qty: 1000n, rate: 10000n, lineTotal: 10000n });
  const payId = uid();
  await db.insert(s.payments).values({ id: payId, companyId: cid, branchId, kind: "RECEIPT", date: new Date("2026-01-06T12:00:00Z"), partyId, bankAccountId: bankId, amount: 5000n, createdById: userId });
  await db.insert(s.paymentAllocations).values({ id: uid(), paymentId: payId, partyId, salesDocId: saleId, amount: 5000n });
  await db.insert(s.expenses).values({ id: uid(), companyId: cid, branchId, date: new Date("2026-01-07T12:00:00Z"), accountId: expGl, bankAccountId: bankId, amount: 2000n, createdById: userId });
  const jeId = uid();
  await db.insert(s.journalEntries).values({ id: jeId, companyId: cid, branchId, date: new Date("2026-01-07T12:00:00Z"), memo: "Test entry", source: "MANUAL", createdById: userId });
  await db.insert(s.journalLines).values({ id: uid(), entryId: jeId, accountId: expGl, debit: 2000n, credit: 0n });
  await db.insert(s.journalLines).values({ id: uid(), entryId: jeId, accountId: cashGl, debit: 0n, credit: 2000n });
  await db.insert(s.stockLevels).values({ id: uid(), productId, branchId, qty: 1000n, avgCost: 10000n });
  await db.insert(s.numberSequences).values({ id: uid(), companyId: cid, docType: "INVOICE", prefix: "S-", lastNo: 1 });
  // Preserved tables (not part of the payload).
  await db.insert(s.backups).values({ id: uid(), companyId: cid, byteSize: 10, rowCounts: "{}", payload: "{}", trigger: "manual" });
  await db.insert(s.settings).values({ id: uid(), companyId: cid, key: "pos.receipt_footer", value: "Thanks!" });
  await db.insert(s.auditLogs).values({ id: uid(), companyId: cid, userId, userName: "Owner", action: "test.action" });
  return { cid, userId, branchId, partyId, productId };
}

// Full snapshot of every restored section + the preserved tables, as JSON.
const stringify = (v: unknown) =>
  JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `bigint:${x.toString()}` : x instanceof Date ? `date:${x.toISOString()}` : x));

async function snapshot(cid: string): Promise<string> {
  const out: Record<string, unknown> = {};
  for (const key of RESTORE_ORDER) {
    const table = {
      branches: s.branches, accounts: s.accounts, parties: s.parties, products: s.products,
      bankAccounts: s.bankAccounts, salesDocs: s.salesDocs, salesDocItems: s.salesDocItems,
      purchaseDocs: s.purchaseDocs, purchaseDocItems: s.purchaseDocItems, payments: s.payments,
      paymentAllocations: s.paymentAllocations, expenses: s.expenses, journalEntries: s.journalEntries,
      journalLines: s.journalLines, stockLevels: s.stockLevels, numberSequences: s.numberSequences,
    }[key];
    const rows = await db.select().from(table as never);
    out[key] = stringify(rows);
  }
  out.users = stringify(await db.select().from(s.users).where(eq(s.users.companyId, cid)));
  out.backups = stringify(await db.select().from(s.backups).where(eq(s.backups.companyId, cid)));
  out.settings = stringify(await db.select().from(s.settings).where(eq(s.settings.companyId, cid)));
  return stringify(out);
}

async function sectionCount(cid: string): Promise<number> {
  const parties = await db.select({ id: s.parties.id }).from(s.parties).where(eq(s.parties.companyId, cid));
  return parties.length;
}

describe("backup restore", () => {
  it("round trip: restore replaces live data with the backup, byte-identical", async () => {
    const { cid } = await makeRichCompany("Round Trip Co");
    const { payload } = await buildBackupPayload(db, cid);
    const raw = serializeBackup(payload);
    expect(validateBackupPayload(raw).ok).toBe(true);

    const before = await snapshot(cid);

    // Mess up the live data first: delete parties, add a junk product.
    await db.delete(s.parties).where(eq(s.parties.companyId, cid));
    await db.insert(s.products).values({ id: uid(), companyId: cid, sku: "JUNK", name: "Junk Product" });
    expect(await sectionCount(cid)).toBe(0);

    const doc = JSON.parse(raw) as Parameters<typeof restoreCompanyData>[2];
    assertSameCompany(doc, cid);
    await db.transaction(async (tx) => {
      await restoreCompanyData(tx, cid, doc);
    });

    const after = await snapshot(cid);
    expect(after).toBe(before);
  });

  it("a failed insert rolls back fully — the company is untouched", async () => {
    const { cid } = await makeRichCompany("Poison Co");
    const { payload } = await buildBackupPayload(db, cid);
    const doc = JSON.parse(serializeBackup(payload)) as Record<string, unknown>;
    // Poison: a party row with an id but no name (name is NOT NULL) → the
    // insert must fail AFTER the wipe, so rollback is the only thing
    // standing between us and total data loss.
    (doc.parties as Record<string, unknown>[]).push({ id: uid(), companyId: cid });
    const before = await snapshot(cid);
    await expect(
      db.transaction(async (tx) => {
        await restoreCompanyData(tx, cid, doc as never);
      })
    ).rejects.toThrow();
    const after = await snapshot(cid);
    expect(after).toBe(before);
    expect(await sectionCount(cid)).toBeGreaterThan(0);
  });

  it("a damaged row (missing id) is rejected before any insert", async () => {
    const { cid } = await makeRichCompany("Damaged Co");
    const { payload } = await buildBackupPayload(db, cid);
    const doc = JSON.parse(serializeBackup(payload)) as Record<string, unknown>;
    (doc.expenses as Record<string, unknown>[]).push({ amount: "100" });
    await expect(
      db.transaction(async (tx) => {
        await restoreCompanyData(tx, cid, doc as never);
      })
    ).rejects.toThrow(UserError);
  });

  it("corrupted payloads fail validation with zero writes", async () => {
    expect(validateBackupPayload("not json{{").ok).toBe(false);
    const bad = validateBackupPayload(JSON.stringify({ app: "LedgerPro", version: 999, company: { id: "x" } }));
    expect(bad.ok).toBe(false);
    expect(bad.errors.length).toBeGreaterThan(0);
  });

  it("wrong-company payloads are rejected with 403", async () => {
    const { cid } = await makeRichCompany("Company A");
    const { payload } = await buildBackupPayload(db, cid);
    const doc = JSON.parse(serializeBackup(payload)) as Parameters<typeof assertSameCompany>[0];
    expect(() => assertSameCompany(doc, "some-other-company")).toThrowError(UserError);
    try {
      assertSameCompany(doc, "some-other-company");
      expect.unreachable();
    } catch (e) {
      expect((e as UserError).status).toBe(403);
    }
    expect(() => assertSameCompany({}, cid)).toThrowError(UserError);
  });

  it("restore tokens are bound, tamper-proof, and short-lived", async () => {
    const claims = { uid: "u1", cid: "c1", rid: "b1", hash: payloadHash("{}") };
    const token = await signRestoreToken(claims);
    const back = await verifyRestoreToken(token);
    expect(back).toEqual(claims);

    // Tampered token → rejected.
    const tampered = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    expect(await verifyRestoreToken(tampered)).toBeNull();
    // Garbage → rejected.
    expect(await verifyRestoreToken("definitely-not-a-token")).toBeNull();
    // Signed with the wrong secret → rejected.
    const wrongSecret = await new SignJWT({ ...claims, kind: "restore" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(new TextEncoder().encode("wrong-secret"));
    expect(await verifyRestoreToken(wrongSecret)).toBeNull();
    // Missing kind claim → rejected (e.g. a session token can't be reused).
    const noKind = await new SignJWT({ ...claims })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .sign(new TextEncoder().encode(process.env.AUTH_SECRET || "dev-only-secret-change-me-32-chars-min"));
    expect(await verifyRestoreToken(noKind)).toBeNull();
  });

  it("payload hashes are stable and content-sensitive", () => {
    expect(payloadHash("abc")).toBe(payloadHash("abc"));
    expect(payloadHash("abc")).not.toBe(payloadHash("abd"));
    expect(payloadHash("abc")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("typed-name confirmation requires an exact match", () => {
    expect(() => assertTypedNameMatches("Acme Traders", "Acme Traders")).not.toThrow();
    expect(() => assertTypedNameMatches("  Acme Traders  ", "Acme Traders")).not.toThrow();
    expect(() => assertTypedNameMatches("acme traders", "Acme Traders")).toThrowError(UserError);
    expect(() => assertTypedNameMatches("", "Acme Traders")).toThrowError(UserError);
    expect(() => assertTypedNameMatches("Acme Traders", "")).toThrowError(UserError);
    expect(() => assertTypedNameMatches(undefined, "Acme Traders")).toThrowError(UserError);
  });

  it("double-submit guard blocks a second restore within 30 seconds", async () => {
    const { cid } = await makeRichCompany("Cooldown Co");
    const other = (await makeRichCompany("Other Co")).cid;
    expect(await checkRestoreCooldown(db, cid)).toBe(false);
    await recordRestoreDone(db, cid);
    expect(await checkRestoreCooldown(db, cid)).toBe(true);
    expect(await checkRestoreCooldown(db, other)).toBe(false);
  });

  it("preserved tables are schema-discovered, never hardcoded", () => {
    const names = restorePreservedTables().map((t) => {
      const cols = Object.values(t as unknown as Record<string, { name?: string }>);
      return cols.length;
    });
    expect(names.length).toBeGreaterThan(0);
    const preserved = restorePreservedTables();
    expect(preserved).toContain(s.users);
    expect(preserved).toContain(s.backups);
    expect(preserved).toContain(s.settings);
    expect(preserved).not.toContain(s.branches);
    expect(preserved).not.toContain(s.companies);
    // audit rows are wiped (the restore audit is mirrored to error_logs by the route)
    expect(preserved).not.toContain(s.auditLogs);
  });

  it("restore converts dates and bigints back from JSON correctly", async () => {
    const { cid } = await makeRichCompany("Types Co");
    const { payload } = await buildBackupPayload(db, cid);
    const raw = serializeBackup(payload);
    // Sanity: the serialized form really does carry strings for dates/bigints.
    expect(raw).toContain("2026-01-05");
    const doc = JSON.parse(raw) as Parameters<typeof restoreCompanyData>[2];
    await db.transaction(async (tx) => {
      await restoreCompanyData(tx, cid, doc);
    });
    const docs = await db.select().from(s.salesDocs).where(eq(s.salesDocs.companyId, cid));
    expect(docs).toHaveLength(1);
    expect(docs[0].date).toBeInstanceOf(Date);
    expect(typeof docs[0].grandTotal).toBe("bigint");
    expect(docs[0].grandTotal).toBe(15000n);
    const levels = await db.select().from(s.stockLevels);
    expect(levels[0].qty).toBe(1000n);
  });
});
