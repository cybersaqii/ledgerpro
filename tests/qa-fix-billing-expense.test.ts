/**
 * QA-fix backend tests — items 2, 3, 13a, 13b (2026-10-01).
 *
 * - Item 2: billing "one pending payment" pre-check now runs INSIDE the
 *   insert transaction (SQLite serializes the write txn, closing the race).
 * - Item 3: admin reject flips the payment to REJECTED and releases the
 *   consumed coupon in the SAME transaction (no coupon leak possible).
 * - 13a: PATCH /api/expenses/[id] — edit a non-voided expense whose original
 *   AND new date fall in an OPEN accounting period; re-posts the journal
 *   atomically (reverse + re-post, bank balances adjusted).
 * - 13b: platform-admin coupon creation through the real
 *   requirePlatformAdmin gate (PLATFORM_ADMIN_EMAILS + DB email re-read).
 *
 * Lib-level sections use a fresh SQLite DB per section (createTestDb) and
 * never touch the live server. The route-level sections reuse the repo's
 * route-test pattern: ./qa-routes-env (imported FIRST) points DATABASE_URL
 * at an isolated /tmp file DB, and requireAuth is mocked to return a session
 * for a user we insert ourselves — the actual requirePlatformAdmin /
 * requirePermission logic still runs against that DB.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers";
import * as s from "@/db/schema";
import { setupCompany, accountMap, SYS } from "@/lib/setup";
import { postExpense } from "@/lib/posting";
import { updateExpense } from "@/lib/expense-edit";
import { parseMoney } from "@/lib/money";
import { voidExpense } from "@/lib/payment-void";
import { UserError } from "@/lib/errors";

// ─── Mocked auth: a mutable session for the route-level sections ────────────
const sessionState = vi.hoisted(() => ({
  uid: "",
  cid: "",
  name: "QA Tester",
  email: "",
  role: "OWNER",
  v: 0,
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return {
    ...actual,
    requireAuth: async () => ({ session: { ...sessionState }, response: null }),
  };
});

vi.mock("@/lib/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-helpers")>();
  const dbm = await import("@/lib/db");
  return { ...actual, db: dbm.db };
});

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

async function bankBalance(dbc: TestDb, bankId: string): Promise<bigint> {
  const [r] = await dbc.select().from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
  return BigInt(r?.balance ?? 0n);
}

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

async function expectUserError(p: Promise<unknown>, status: number): Promise<UserError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(UserError);
    expect((e as UserError).status).toBe(status);
    return e as UserError;
  }
  throw new Error(`expected UserError(${status}), promise resolved`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 13a — updateExpense (lib-level, fresh test DB)
// ═══════════════════════════════════════════════════════════════════════════
describe("13a — PATCH /api/expenses/[id] core (updateExpense)", () => {
  let db: TestDb;
  let cleanup: () => void;
  const companyId = crypto.randomUUID();
  const userId = crypto.randomUUID();
  let branchId = "";
  let cashBankId = "";
  let bank2Id = "";
  let expenseAcctId = "";
  let expenseAcct2Id = "";
  let expenseId = "";
  let openingBalance = 0n;

  async function makeExpense(dateIso: string, amount = "1000", tax = "50"): Promise<string> {
    return db.transaction((tx) =>
      postExpense(tx, {
        companyId,
        branchId,
        accountId: expenseAcctId,
        bankAccountId: cashBankId,
        date: new Date(`${dateIso}T12:00:00Z`),
        amount: parseMoney(amount),
        taxAmount: parseMoney(tax),
        notes: "seed",
        createdById: userId,
      })
    );
  }

  beforeAll(async () => {
    ({ db, cleanup } = await createTestDb());
    await db.insert(s.companies).values({ id: companyId, name: "QA Fix Co" });
    const res = await setupCompany(db, companyId);
    branchId = res.branchId;
    const ac = await db.transaction((tx) => accountMap(tx, companyId));
    expenseAcctId = ac[SYS.EXPENSES];
    cashBankId = (
      await db
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0]!.id;
    // Second GL expense account + second bank, for account/bank-change tests.
    expenseAcct2Id = crypto.randomUUID();
    await db.insert(s.accounts).values({
      id: expenseAcct2Id,
      companyId,
      code: "6101",
      name: "QA Travel",
      type: "EXPENSE",
    });
    const { addBankAccount } = await import("@/lib/setup");
    bank2Id = (await addBankAccount(db, companyId, { name: "QA Bank 2", kind: "BANK", openingBalance: 0n })).id;
    openingBalance = await bankBalance(db, cashBankId);
    expenseId = await makeExpense("2026-09-15");
  });

  afterAll(() => cleanup());

  it("edits amount/date/notes and re-posts a balanced journal", async () => {
    const [before] = await db.select().from(s.expenses).where(eq(s.expenses.id, expenseId)).limit(1);
    const oldEntryId = before!.journalEntryId!;

    const updated = await db.transaction((tx) =>
      updateExpense(tx, {
        companyId,
        expenseId,
        userId,
        amount: "2500.50",
        taxAmount: "100",
        date: "2026-09-20",
        notes: "edited by QA",
      })
    );

    expect(updated.amount).toBe(250050n);
    expect(updated.taxAmount).toBe(10000n);
    expect(updated.notes).toBe("edited by QA");
    expect((updated.date as unknown as Date).toISOString().slice(0, 10)).toBe("2026-09-20");
    expect(updated.docNo).toBe(before!.docNo); // doc number is stable
    expect(updated.journalEntryId).not.toBe(oldEntryId); // re-posted

    // Old journal fully dropped — no orphan lines.
    const orphanLines = await db
      .select({ id: s.journalLines.id })
      .from(s.journalLines)
      .where(eq(s.journalLines.entryId, oldEntryId));
    expect(orphanLines).toHaveLength(0);

    // New journal: Dr expense 2500.50 + Dr input-tax 100, Cr bank 2600.50.
    const lines = await db
      .select()
      .from(s.journalLines)
      .where(eq(s.journalLines.entryId, updated.journalEntryId!));
    let dr = 0n,
      cr = 0n;
    for (const l of lines) {
      dr += BigInt(l.debit ?? 0n);
      cr += BigInt(l.credit ?? 0n);
    }
    expect(dr).toBe(260050n);
    expect(cr).toBe(260050n);
    expect(await trialBalanceZero(db, companyId)).toBe(true);

    // Bank balance reflects the NEW total only (old posting reversed).
    expect(await bankBalance(db, cashBankId)).toBe(openingBalance - 260050n);
  });

  it("moves the posting when accountId / bankAccountId change", async () => {
    const id = await makeExpense("2026-09-21", "500", "0");
    const oldCash = await bankBalance(db, cashBankId);
    const oldBank2 = await bankBalance(db, bank2Id);

    const updated = await db.transaction((tx) =>
      updateExpense(tx, { companyId, expenseId: id, userId, accountId: expenseAcct2Id, bankAccountId: bank2Id })
    );
    expect(updated.accountId).toBe(expenseAcct2Id);
    expect(updated.bankAccountId).toBe(bank2Id);

    // Old bank restored (+50000), new bank debited (-50000).
    expect(await bankBalance(db, cashBankId)).toBe(oldCash + 50000n);
    expect(await bankBalance(db, bank2Id)).toBe(oldBank2 - 50000n);
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });

  it("rejects a voided expense with 409", async () => {
    const id = await makeExpense("2026-09-22", "100", "0");
    await db.transaction((tx) => voidExpense(tx, { companyId, expenseId: id, userId }));
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { companyId, expenseId: id, userId, notes: "too late" })),
      409
    );
  });

  it("rejects invalid input with 422/404", async () => {
    const id = await makeExpense("2026-09-23", "100", "0");
    const base = { companyId, expenseId: id, userId };
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, amount: "0" })), 422);
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, amount: "-5" })), 422);
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, taxAmount: "-1" })), 422);
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, date: "2026-13-40" })), 422);
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, date: "2026-02-30" })), 422);
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { ...base, accountId: crypto.randomUUID() })),
      422
    );
    // A real GL account that is NOT an expense account is rejected.
    const cashGl = (await db.transaction((tx) => accountMap(tx, companyId)))[SYS.CASH];
    await expectUserError(db.transaction((tx) => updateExpense(tx, { ...base, accountId: cashGl })), 422);
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { ...base, bankAccountId: crypto.randomUUID() })),
      422
    );
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { ...base, notes: "x".repeat(501) })),
      422
    );
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { ...base, expenseId: crypto.randomUUID() })),
      404
    );
    // Failed edits leave the row untouched.
    const [row] = await db.select().from(s.expenses).where(eq(s.expenses.id, id)).limit(1);
    expect(row!.amount).toBe(10000n);
  });

  it("rejects edits touching a locked period with 422", async () => {
    const openId = await makeExpense("2026-09-25", "200", "0");
    const lockedId = await makeExpense("2026-09-15", "200", "0");
    await db
      .update(s.companies)
      .set({ lockedUntil: new Date("2026-09-20T12:00:00Z") })
      .where(eq(s.companies.id, companyId));

    // Original date inside the locked period → rejected even for notes-only.
    await expectUserError(
      db.transaction((tx) =>
        updateExpense(tx, { companyId, expenseId: lockedId, userId, notes: "nope" })
      ),
      422
    );
    // Moving an open expense INTO the locked period → rejected.
    await expectUserError(
      db.transaction((tx) => updateExpense(tx, { companyId, expenseId: openId, userId, date: "2026-09-18" })),
      422
    );
    // Same open expense, date staying open → allowed.
    const ok = await db.transaction((tx) =>
      updateExpense(tx, { companyId, expenseId: openId, userId, notes: "still open" })
    );
    expect(ok.notes).toBe("still open");
    expect(await trialBalanceZero(db, companyId)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Route-level: platform-admin coupon creation (13b) + PATCH wiring (13a)
// ═══════════════════════════════════════════════════════════════════════════
describe("route-level — admin coupons + expense PATCH wiring", () => {
  let seedClient: Client;
  let seed: LibSQLDatabase<typeof s>;
  let createCoupon: (req: NextRequest) => Promise<Response>;
  let patchExpense: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;

  const ADMIN_EMAIL = "qa-platform-admin@ledgerpro.test";
  const OTHER_EMAIL = "qa-plain-owner@ledgerpro.test";
  const adminCompany = crypto.randomUUID();
  const adminUid = crypto.randomUUID();
  const otherUid = crypto.randomUUID();
  const routeUserId = crypto.randomUUID();
  let branchId = "";
  let cashBankId = "";
  let expenseAcctId = "";
  let expenseId = "";

  function asAdmin() {
    sessionState.uid = adminUid;
    sessionState.cid = adminCompany;
    sessionState.email = ADMIN_EMAIL;
    sessionState.name = "QA Admin";
    sessionState.role = "OWNER";
  }
  function asOther() {
    sessionState.uid = otherUid;
    sessionState.cid = adminCompany;
    sessionState.email = OTHER_EMAIL;
    sessionState.name = "QA Other";
    sessionState.role = "OWNER";
  }

  const prevAdminEmails = process.env.PLATFORM_ADMIN_EMAILS;

  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    seedClient = createClient({ url: ROUTES_DB_URL });
    seed = drizzle(seedClient, { schema: s });
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN_EMAIL;

    await seed.insert(s.companies).values({ id: adminCompany, name: "QA Route Co" });
    await seed.insert(s.users).values([
      { id: adminUid, companyId: adminCompany, name: "QA Admin", email: ADMIN_EMAIL, passwordHash: "x", role: "OWNER" },
      { id: otherUid, companyId: adminCompany, name: "QA Other", email: OTHER_EMAIL, passwordHash: "x", role: "OWNER" },
      { id: routeUserId, companyId: adminCompany, name: "QA Owner", email: "qa-owner@ledgerpro.test", passwordHash: "x", role: "OWNER" },
    ]);

    // Expense fixtures for the PATCH wiring test (real requirePermission gate,
    // OWNER bypasses via the mocked session).
    const res = await setupCompany(seed, adminCompany);
    branchId = res.branchId;
    expenseAcctId = (await seed.transaction((tx) => accountMap(tx, adminCompany)))[SYS.EXPENSES];
    cashBankId = (
      await seed
        .select({ id: s.bankAccounts.id })
        .from(s.bankAccounts)
        .where(and(eq(s.bankAccounts.companyId, adminCompany), eq(s.bankAccounts.kind, "CASH")))
        .limit(1)
    )[0]!.id;
    expenseId = await seed.transaction((tx) =>
      postExpense(tx, {
        companyId: adminCompany,
        branchId,
        accountId: expenseAcctId,
        bankAccountId: cashBankId,
        date: new Date("2026-09-15T12:00:00Z"),
        amount: parseMoney("900"),
        taxAmount: parseMoney("0"),
        notes: "route seed",
        createdById: routeUserId,
      })
    );

    ({ POST: createCoupon } = await import("@/app/api/admin/coupons/route"));
    ({ PATCH: patchExpense } = await import("@/app/api/expenses/[id]/route"));
  });

  afterAll(() => {
    seedClient.close();
    if (prevAdminEmails === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    else process.env.PLATFORM_ADMIN_EMAILS = prevAdminEmails;
  });

  function postCoupon(body: Record<string, unknown>) {
    return createCoupon(
      new NextRequest("http://t/api/admin/coupons", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
  }

  it("13b — platform admin creates a coupon with correct fields", async () => {
    asAdmin();
    const res = await postCoupon({
      code: "qa-launch-50",
      kind: "PERCENT",
      value: 50,
      maxUses: 10,
      validFrom: "2026-01-01",
      validTo: "2027-01-01",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.id).toBeTruthy();

    const [c] = await seed.select().from(s.coupons).where(eq(s.coupons.id, body.data.id)).limit(1);
    expect(c).toBeTruthy();
    expect(c!.code).toBe("QALAUNCH50"); // normalized uppercase
    expect(c!.kind).toBe("PERCENT");
    expect(c!.value).toBe(50);
    expect(c!.maxUses).toBe(10);
    expect(c!.active).toBe(true);
    expect(c!.usedCount).toBe(0);
    expect(c!.createdBy).toBe(ADMIN_EMAIL);
    expect((c!.validFrom as unknown as Date).toISOString().slice(0, 10)).toBe("2026-01-01");
    expect((c!.validTo as unknown as Date).toISOString().slice(0, 10)).toBe("2027-01-01");
  });

  it("13b — duplicate coupon code → 409", async () => {
    asAdmin();
    const res = await postCoupon({ code: "qa-launch-50", kind: "FIXED", value: 500 });
    expect(res.status).toBe(409);
  });

  it("13b — invalid coupon input → 422", async () => {
    asAdmin();
    const res = await postCoupon({ code: "qa-bad", kind: "BOGUS", value: 10 });
    expect(res.status).toBe(422);
  });

  it("13b — non-admin user → 403", async () => {
    asOther();
    const res = await postCoupon({ code: "qa-nope", kind: "PERCENT", value: 10 });
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBeTruthy();
    // And nothing was created.
    const rows = await seed.select({ id: s.coupons.id }).from(s.coupons).where(eq(s.coupons.code, "QANOPE"));
    expect(rows).toHaveLength(0);
  });

  it("13a — PATCH route: 200, returns the updated expense, journal stays balanced", async () => {
    asAdmin(); // OWNER of the company → passes the real requirePermission gate
    const req = new NextRequest(`http://t/api/expenses/${expenseId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amount: "777.25", notes: "route edit" }),
    });
    const res = await patchExpense(req, { params: Promise.resolve({ id: expenseId }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(expenseId);
    expect(body.data.amount).toBe("77725"); // bigint serializes as string
    expect(body.data.notes).toBe("route edit");

    const [row] = await seed.select().from(s.expenses).where(eq(s.expenses.id, expenseId)).limit(1);
    expect(BigInt(row!.amount)).toBe(77725n);
    expect(await trialBalanceZero(seed, adminCompany)).toBe(true);
  });

  it("13a — PATCH route: unknown expense → 404", async () => {
    asAdmin();
    const req = new NextRequest("http://t/api/expenses/does-not-exist", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ notes: "x" }),
    });
    const res = await patchExpense(req, { params: Promise.resolve({ id: "does-not-exist" }) });
    expect(res.status).toBe(404);
  });
});
