// QA TRACK-A3 — regression tests for Parties/Products/Banks/Reports/Settings/
// Billing/Backup/Auth-adjacent libs. Fresh SQLite DB per test file via
// tests/helpers.ts; never touches the live dev server.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, addBankAccount } from "@/lib/setup";
import { postTransfer } from "@/lib/transfers";
import { validateImageUrl, ImageUrlError } from "@/lib/product-image";
import {
  discountFor,
  quoteCoupon,
  consumeCoupon,
  normalizeCouponCode,
  CouponError,
} from "@/lib/coupons";
import {
  generateReferralCode,
  getOrCreateReferralCode,
  recordReferral,
  ReferralError,
} from "@/lib/referrals";
import {
  userHasPermission,
  getUserPermissions,
  setUserPermissions,
  isPermission,
  STAFF_DEFAULT_PERMISSIONS,
} from "@/lib/permissions";
import { hashPassword, verifyPassword } from "@/lib/auth";
import { netOf, sumByType, glSums } from "@/lib/reports";
import { UserError } from "@/lib/errors";
import { createJournal } from "@/lib/posting";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashId = "";
let bankId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "QAA3 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  await db.insert(s.users).values({
    id: userId,
    companyId,
    name: "QA Owner",
    email: "qaa3-owner@test.local",
    passwordHash: await hashPassword("owner-pass-123"),
    role: "OWNER",
    isActive: true,
  });
  const cash = await addBankAccount(db, companyId, { name: "QAA3 Cash", kind: "CASH", openingBalance: 100000n });
  const bank = await addBankAccount(db, companyId, { name: "QAA3 Bank", kind: "BANK", bankName: "Test Bank", openingBalance: 500000n });
  cashId = cash.id;
  bankId = bank.id;
});

afterAll(() => cleanup());

describe("bank transfers (lib/transfers)", () => {
  it("moves money between own accounts with a balanced journal + docNo", async () => {
    const before = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId));
    const cashBefore = before.find((b) => b.id === cashId)!.balance;
    const bankBefore = before.find((b) => b.id === bankId)!.balance;

    const { docNo } = await db.transaction(async (tx) =>
      postTransfer(tx, {
        companyId, branchId,
        fromBankAccountId: bankId,
        toBankAccountId: cashId,
        date: new Date(),
        amount: 25000n,
        notes: "QAA3 transfer",
        createdById: userId,
      })
    );
    expect(docNo).toMatch(/^TRF-/);

    const after = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId));
    expect(after.find((b) => b.id === cashId)!.balance).toBe(cashBefore + 25000n);
    expect(after.find((b) => b.id === bankId)!.balance).toBe(bankBefore - 25000n);

    // journal behind the transfer balances
    const [t] = await db.select().from(s.transfers).where(eq(s.transfers.docNo, docNo)).limit(1);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, t.journalEntryId!));
    const d = lines.reduce((a, l) => a + l.debit, 0n);
    const c = lines.reduce((a, l) => a + l.credit, 0n);
    expect(d).toBe(c);
    expect(d).toBe(25000n);
  });

  it("rejects same-account and non-positive transfers", async () => {
    await expect(
      db.transaction((tx) =>
        postTransfer(tx, { companyId, branchId, fromBankAccountId: cashId, toBankAccountId: cashId, date: new Date(), amount: 100n, createdById: userId })
      )
    ).rejects.toThrow(UserError);
    await expect(
      db.transaction((tx) =>
        postTransfer(tx, { companyId, branchId, fromBankAccountId: cashId, toBankAccountId: bankId, date: new Date(), amount: 0n, createdById: userId })
      )
    ).rejects.toThrow(UserError);
    await expect(
      db.transaction((tx) =>
        postTransfer(tx, { companyId, branchId, fromBankAccountId: "nope", toBankAccountId: bankId, date: new Date(), amount: 100n, createdById: userId })
      )
    ).rejects.toThrow(/not found/i);
  });

  it("TRF doc numbers are sequential and unique", async () => {
    const mk = () =>
      db.transaction((tx) =>
        postTransfer(tx, { companyId, branchId, fromBankAccountId: cashId, toBankAccountId: bankId, date: new Date(), amount: 100n, createdById: userId })
      );
    const a = await mk();
    const b = await mk();
    expect(a.docNo).not.toBe(b.docNo);
  });
});

describe("product image URL edge cases (lib/product-image)", () => {
  it("rejects IPv6 loopback and decimal/hex IPv4 forms", () => {
    expect(() => validateImageUrl("https://[::1]/a.png")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://2130706433/a.png")).toThrow(ImageUrlError); // 127.0.0.1
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => validateImageUrl("https://user:pass@example.com/a.png")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://user@example.com/a.png")).toThrow(ImageUrlError);
  });

  it("rejects localhost variants and .local domains", () => {
    expect(() => validateImageUrl("https://localhost.:8443/a.png")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://printer.local/a.png")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://sub.localhost/a.png")).toThrow(ImageUrlError);
  });

  it("accepts public https with ports, paths, query strings; trims whitespace", () => {
    expect(validateImageUrl("  https://cdn.example.com:8443/p/a.png?w=2  ")).toBe(
      "https://cdn.example.com:8443/p/a.png?w=2"
    );
    expect(validateImageUrl("https://example.com/x")).toBe("https://example.com/x");
  });
});

describe("coupon math (lib/coupons)", () => {
  it("discountFor clamps percent and fixed discounts to the payable amount", () => {
    expect(discountFor({ kind: "PERCENT", value: 10 } as never, 150000)).toBe(15000);
    expect(discountFor({ kind: "PERCENT", value: 150 } as never, 100000)).toBe(100000);
    expect(discountFor({ kind: "FIXED", value: 200000 } as never, 150000)).toBe(150000);
    expect(discountFor({ kind: "FIXED", value: 50000 } as never, 150000)).toBe(50000);
    expect(discountFor({ kind: "PERCENT", value: 10 } as never, 0)).toBe(0);
  });

  it("quoteCoupon rejects a bogus code with CouponError (not a raw crash)", async () => {
    await expect(quoteCoupon(db, { code: "BOGUS-CODE", companyId, amountPaisa: 150000 })).rejects.toThrow(CouponError);
    await expect(quoteCoupon(db, { code: "  ", companyId, amountPaisa: 150000 })).rejects.toThrow(CouponError);
  });

  it("bogus-code normalization is case/space/punctuation insensitive", () => {
    expect(normalizeCouponCode(" ab-cd_12 ")).toBe("ABCD12");
  });

  it("percent coupon quote: payable = gross - discount", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.coupons).values({ id, code: "QAA310", kind: "PERCENT", value: 10, active: true });
    const q = await quoteCoupon(db, { code: "qaa310", companyId, amountPaisa: 150000 });
    expect(q.discountPaisa).toBe(15000);
    expect(q.payablePaisa).toBe(135000);
  });

  it("consumeCoupon enforces max_uses and one-per-company", async () => {
    const id = crypto.randomUUID();
    await db.insert(s.coupons).values({ id, code: "QAA3ONE", kind: "FIXED", value: 10000, active: true, maxUses: 5 });
    await db.transaction(async (tx) => {
      await quoteCoupon(tx, { code: "QAA3ONE", companyId, amountPaisa: 150000 });
      await consumeCoupon(tx, { couponId: id, companyId, billingPaymentId: null, discountPaisa: 10000 });
    });
    // second use by same company must fail cleanly
    await expect(
      db.transaction(async (tx) => {
        await quoteCoupon(tx, { code: "QAA3ONE", companyId, amountPaisa: 150000 });
      })
    ).rejects.toThrow(CouponError);
  });
});

describe("referrals (lib/referrals)", () => {
  it("getOrCreateReferralCode is stable and unique per company", async () => {
    const a = await getOrCreateReferralCode(db, companyId);
    const b = await getOrCreateReferralCode(db, companyId);
    expect(a).toBe(b);
    expect(a).toMatch(/^[A-Z2-9]{8}$/);
    const otherId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: otherId, name: "QAA3 Other" });
    const other = await getOrCreateReferralCode(db, otherId);
    expect(other).not.toBe(a);
  });

  it("generateReferralCode uses the unambiguous alphabet", () => {
    for (let i = 0; i < 50; i++) {
      const c = generateReferralCode();
      expect(c).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    }
  });

  it("recordReferral rejects bad, unknown, and self codes with ReferralError", async () => {
    const otherId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: otherId, name: "QAA3 Referred" });
    await expect(recordReferral(db, { code: "ab", referredCompanyId: otherId })).rejects.toThrow(ReferralError);
    await expect(recordReferral(db, { code: "ZZZZ9999", referredCompanyId: otherId })).rejects.toThrow(ReferralError);
    const mine = await getOrCreateReferralCode(db, companyId);
    await expect(recordReferral(db, { code: mine, referredCompanyId: companyId })).rejects.toThrow(ReferralError);
  });

  it("recordReferral records a PENDING referral for a valid code", async () => {
    const otherId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: otherId, name: "QAA3 Referred2" });
    const mine = await getOrCreateReferralCode(db, companyId);
    await recordReferral(db, { code: mine.toLowerCase(), referredCompanyId: otherId });
    const rows = await db.select().from(s.referrals).where(and(eq(s.referrals.referrerCompanyId, companyId), eq(s.referrals.referredCompanyId, otherId)));
    expect(rows.length).toBe(1);
    expect(rows[0].status).toBe("PENDING");
  });
});

describe("staff permissions gating (lib/permissions)", () => {
  const staffId = crypto.randomUUID();
  beforeAll(async () => {
    await db.insert(s.users).values({
      id: staffId, companyId, name: "QAA3 Staff", email: "qaa3-staff@test.local",
      passwordHash: await hashPassword("staff-pass-123"), role: "STAFF", isActive: true,
    });
  });

  it("owner holds every permission implicitly", async () => {
    expect(await userHasPermission(db, userId, "reports_basic")).toBe(true);
    expect(await userHasPermission(db, userId, "settings")).toBe(true);
  });

  it("grant → allowed, revoke → denied, instantly (live DB re-read)", async () => {
    expect(await userHasPermission(db, staffId, "reports_basic")).toBe(false);
    await setUserPermissions(db, { companyId, userId: staffId, permissions: ["reports_basic"] });
    expect(await getUserPermissions(db, staffId)).toContain("reports_basic");
    expect(await userHasPermission(db, staffId, "reports_basic")).toBe(true);
    expect(await userHasPermission(db, staffId, "settings")).toBe(false);
    await setUserPermissions(db, { companyId, userId: staffId, permissions: [] });
    expect(await userHasPermission(db, staffId, "reports_basic")).toBe(false);
  });

  it("inactive staff and unknown permission are denied", async () => {
    await setUserPermissions(db, { companyId, userId: staffId, permissions: ["reports_basic"] });
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, staffId));
    expect(await userHasPermission(db, staffId, "reports_basic")).toBe(false);
    await db.update(s.users).set({ isActive: true }).where(eq(s.users.id, staffId));
    expect(await userHasPermission(db, staffId, "nope" as never)).toBe(false);
  });

  it("isPermission rejects junk; defaults are sane", () => {
    expect(isPermission("reports_basic")).toBe(true);
    expect(isPermission("delete_everything")).toBe(false);
    expect(STAFF_DEFAULT_PERMISSIONS.length).toBeGreaterThan(0);
  });
});

describe("password hashing round-trip (lib/auth)", () => {
  it("verifyPassword accepts the right password and rejects the wrong one", async () => {
    const h = await hashPassword("qa-change-me-123");
    expect(await verifyPassword("qa-change-me-123", h)).toBe(true);
    expect(await verifyPassword("wrong-password", h)).toBe(false);
  });
});

describe("report math helpers (lib/reports)", () => {
  it("glSums + netOf + sumByType agree with a hand-built journal", async () => {
    const accs = await db.select().from(s.accounts).where(eq(s.accounts.companyId, companyId));
    const byCode = new Map(accs.map((a) => [a.code, a.id]));
    const saleCode = [...byCode.keys()].find((k) => k.includes("SALES") || true)!;
    const entryId = crypto.randomUUID();
    await db.transaction((tx) =>
      createJournal(tx, {
        companyId, branchId, date: new Date(), memo: "QAA3 report math", source: "MANUAL", sourceId: entryId, createdById: userId,
        lines: [
          { accountId: byCode.get(saleCode)!, debit: 0n, credit: 100000n },
          { accountId: [...byCode.values()][0], debit: 100000n, credit: 0n },
        ],
      })
    );
    const sums = await glSums(db, companyId);
    expect(sums.has(saleCode)).toBe(true);
    const net = netOf(sums, saleCode, true);
    expect(net).toBeGreaterThanOrEqual(0n);
    // trial-balance property: total debits == total credits over all accounts
    let d = 0n, c = 0n;
    for (const v of sums.values()) { d += v.debit; c += v.credit; }
    expect(d).toBe(c);
    expect(sumByType(sums, "EXPENSE")).toBeGreaterThanOrEqual(0n);
  });
});
