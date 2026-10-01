/**
 * Module 23 — credit control (aging rules, auto holds, risk, priority).
 *
 * Covers: rules CRUD (getCreditRules/upsertCreditRules, defaults are
 * disabled); computeRiskCategory buckets; partyAging bucketing incl. partial
 * payments and ignored doc types; evaluateCreditHold auto-hold on overdue
 * and utilization rules, manual-hold stickiness, SYSTEM auto-release, and
 * no-duplicate events when the status doesn't flip; placeCreditHold /
 * releaseCreditHold with audit events; assertCreditOk (409 CREDIT_ON_HOLD,
 * cash never blocked); collectionPriority ranking.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { insertParty } from "@/lib/party-create";
import * as s from "@/db/schema";
import {
  getCreditRules,
  upsertCreditRules,
  partyAging,
  computeRiskCategory,
  evaluateCreditHold,
  placeCreditHold,
  releaseCreditHold,
  assertCreditOk,
  CreditHoldError,
  collectionPriority,
} from "@/lib/credit-control";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = "test-user";
let branchId = "";

const custA = crypto.randomUUID(); // overdue-heavy customer
const custB = crypto.randomUUID(); // healthy customer
const custC = crypto.randomUUID(); // high-utilization customer

// Fixed "today": 2026-06-01T00:00:00Z.
const NOW = Date.UTC(2026, 5, 1);
const day = 86_400_000;
const ago = (days: number) => new Date(NOW - days * day);
const ahead = (days: number) => new Date(NOW + days * day);

let docSeq = 0;
async function addInvoice(
  partyId: string,
  opts: { daysAgo: number; dueInDays?: number; grandTotal: bigint; amountPaid?: bigint; docType?: string; status?: string }
) {
  docSeq++;
  await db.insert(s.salesDocs).values({
    id: crypto.randomUUID(),
    companyId,
    branchId,
    partyId,
    docType: opts.docType ?? "INVOICE",
    docNo: `M23-${docSeq}`,
    date: ago(opts.daysAgo),
    dueDate: opts.dueInDays != null ? ahead(opts.dueInDays) : ago(opts.daysAgo),
    status: opts.status ?? "POSTED",
    grandTotal: opts.grandTotal,
    amountPaid: opts.amountPaid ?? 0n,
    returnedTotal: 0n,
    writtenOffAmount: 0n,
    createdById: userId,
  });
}

async function partyRow(id: string) {
  return (
    await db.select().from(s.parties).where(and(eq(s.parties.id, id), eq(s.parties.companyId, companyId))).limit(1)
  )[0]!;
}

async function holdEvents(partyId: string) {
  return db
    .select()
    .from(s.creditHoldEvents)
    .where(and(eq(s.creditHoldEvents.companyId, companyId), eq(s.creditHoldEvents.partyId, partyId)));
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "M23 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  for (const [id, name] of [
    [custA, "M23 Overdue Co"],
    [custB, "M23 Healthy Co"],
    [custC, "M23 Util Co"],
  ] as const) {
    await db.transaction((tx) =>
      insertParty(tx, { companyId, userId, id, fields: { kind: "CUSTOMER", name } })
    );
  }

  // custA: one 100-day-overdue invoice (Rs 1,000), one 45-day-overdue (Rs 500),
  // one 10-day-overdue with a partial payment (Rs 2,000 - Rs 800 paid),
  // one not-yet-due invoice (Rs 300).
  await addInvoice(custA, { daysAgo: 100, grandTotal: 100_000n });
  await addInvoice(custA, { daysAgo: 45, grandTotal: 50_000n });
  await addInvoice(custA, { daysAgo: 10, grandTotal: 200_000n, amountPaid: 80_000n });
  await addInvoice(custA, { daysAgo: 5, dueInDays: 10, grandTotal: 30_000n });
  // Ignored by aging: a quotation and a DRAFT invoice.
  await addInvoice(custA, { daysAgo: 200, grandTotal: 999_000n, docType: "QUOTATION" });
  await addInvoice(custA, { daysAgo: 200, grandTotal: 888_000n, status: "DRAFT" });

  // custB: one small 5-day-overdue invoice.
  await addInvoice(custB, { daysAgo: 5, grandTotal: 10_000n });

  // custC: Rs 90,000 balance against a Rs 100,000 limit (set below).
  await addInvoice(custC, { daysAgo: 2, grandTotal: 90_000n });
  await db
    .update(s.parties)
    .set({ balance: 90_000n, creditLimit: 100_000n })
    .where(eq(s.parties.id, custC));
});

afterAll(() => cleanup());

// ─── rules CRUD ──────────────────────────────────────────────────────

describe("23.1 credit rules", () => {
  it("defaults to both rules disabled", async () => {
    const rules = await getCreditRules(db, companyId);
    expect(rules.blockIfOverdueDays).toBeNull();
    expect(rules.blockIfUtilizationPct).toBeNull();
  });

  it("upserts and reads back", async () => {
    await db.transaction((tx) => upsertCreditRules(tx, companyId, { blockIfOverdueDays: 60, blockIfUtilizationPct: 90 }, userId));
    const rules = await getCreditRules(db, companyId);
    expect(rules.blockIfOverdueDays).toBe(60);
    expect(rules.blockIfUtilizationPct).toBe(90);
    // Second upsert overwrites (one row per company).
    await db.transaction((tx) => upsertCreditRules(tx, companyId, { blockIfOverdueDays: null, blockIfUtilizationPct: 80 }, userId));
    const again = await getCreditRules(db, companyId);
    expect(again.blockIfOverdueDays).toBeNull();
    expect(again.blockIfUtilizationPct).toBe(80);
    const rows = await db.select().from(s.creditRules).where(eq(s.creditRules.companyId, companyId));
    expect(rows).toHaveLength(1);
  });
});

// ─── risk + aging ────────────────────────────────────────────────────

describe("23.2 risk categories", () => {
  const empty = { notDue: 0n, d30: 0n, d60: 0n, d90: 0n, d90plus: 0n };
  it("90+ days overdue → HIGH", () => expect(computeRiskCategory({ ...empty, d90plus: 1n })).toBe("HIGH"));
  it("31–90 days → MEDIUM", () => {
    expect(computeRiskCategory({ ...empty, d60: 1n })).toBe("MEDIUM");
    expect(computeRiskCategory({ ...empty, d90: 1n })).toBe("MEDIUM");
  });
  it("recent / not-due → LOW", () => {
    expect(computeRiskCategory({ ...empty, d30: 1n })).toBe("LOW");
    expect(computeRiskCategory(empty)).toBe("LOW");
  });
});

describe("23.3 party aging", () => {
  it("buckets invoices and nets partial payments", async () => {
    const aging = await partyAging(db, companyId, custA, NOW);
    expect(aging.buckets.d90plus).toBe(100_000n);
    expect(aging.buckets.d60).toBe(50_000n);
    expect(aging.buckets.d30).toBe(120_000n); // 200,000 − 80,000 paid
    expect(aging.buckets.notDue).toBe(30_000n);
    expect(aging.totalOutstanding).toBe(300_000n);
    expect(aging.maxDaysOverdue).toBe(100);
    // The quotation and the DRAFT invoice are ignored.
    expect(aging.totalOutstanding).toBeLessThan(1_000_000n);
  });

  it("returns zeros for a customer with no open invoices", async () => {
    const id = crypto.randomUUID();
    await db.transaction((tx) =>
      insertParty(tx, { companyId, userId, id, fields: { kind: "CUSTOMER", name: "M23 Empty Co" } })
    );
    const aging = await partyAging(db, companyId, id, NOW);
    expect(aging.totalOutstanding).toBe(0n);
    expect(aging.maxDaysOverdue).toBe(0);
  });
});

// ─── auto holds ──────────────────────────────────────────────────────

describe("23.4 evaluateCreditHold", () => {
  it("holds a customer past the overdue rule and writes one event", async () => {
    await db.transaction((tx) => upsertCreditRules(tx, companyId, { blockIfOverdueDays: 60, blockIfUtilizationPct: null }, userId));
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: custA, actor: "SYSTEM", nowMs: NOW })
    );
    expect(d.held).toBe(true);
    expect(d.reason).toContain("100 days overdue");
    expect(d.risk).toBe("HIGH");
    const p = await partyRow(custA);
    expect(p.creditStatus).toBe("HOLD");
    expect(p.riskCategory).toBe("HIGH");
    expect(await holdEvents(custA)).toHaveLength(1);

    // Re-evaluating with the same breach writes no duplicate event.
    await db.transaction((tx) => evaluateCreditHold(tx, { companyId, partyId: custA, actor: "SYSTEM", nowMs: NOW }));
    expect(await holdEvents(custA)).toHaveLength(1);
  });

  it("does not hold a healthy customer but refreshes risk", async () => {
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: custB, actor: "SYSTEM", nowMs: NOW })
    );
    expect(d.held).toBe(false);
    expect(d.risk).toBe("LOW");
    const p = await partyRow(custB);
    expect(p.creditStatus).toBe("OK");
    expect(p.riskCategory).toBe("LOW");
  });

  it("holds on the utilization rule", async () => {
    await db.transaction((tx) => upsertCreditRules(tx, companyId, { blockIfOverdueDays: null, blockIfUtilizationPct: 80 }, userId));
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: custC, actor: "SYSTEM", nowMs: NOW })
    );
    expect(d.held).toBe(true);
    expect(d.reason).toContain("90%");
  });

  it("releases a SYSTEM auto-hold once the customer is back within the rules", async () => {
    // Pay custA's invoices in full → no breach → auto-release.
    await db.update(s.salesDocs).set({ amountPaid: 100_000n }).where(and(eq(s.salesDocs.partyId, custA), eq(s.salesDocs.docNo, "M23-1")));
    await db.update(s.salesDocs).set({ amountPaid: 50_000n }).where(and(eq(s.salesDocs.partyId, custA), eq(s.salesDocs.docNo, "M23-2")));
    await db.update(s.salesDocs).set({ amountPaid: 200_000n }).where(and(eq(s.salesDocs.partyId, custA), eq(s.salesDocs.docNo, "M23-3")));
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: custA, actor: "SYSTEM", nowMs: NOW })
    );
    expect(d.held).toBe(false);
    const p = await partyRow(custA);
    expect(p.creditStatus).toBe("OK");
    expect(p.creditHoldReason).toBeNull();
    const events = await holdEvents(custA);
    expect(events.map((e) => e.action)).toEqual(["HOLD", "RELEASE"]);
  });

  it("manual holds are sticky — the rule engine cannot clear them", async () => {
    await db.transaction((tx) => placeCreditHold(tx, { companyId, partyId: custB, reason: "Owner decision", userId }));
    const d = await db.transaction((tx) =>
      evaluateCreditHold(tx, { companyId, partyId: custB, actor: "SYSTEM", nowMs: NOW })
    );
    expect(d.held).toBe(true);
    expect(d.reason).toBe("Owner decision");
    const p = await partyRow(custB);
    expect(p.creditStatus).toBe("HOLD");
  });
});

describe("23.5 manual hold / release", () => {
  it("releaseCreditHold clears the hold and logs the event", async () => {
    await db.transaction((tx) => releaseCreditHold(tx, { companyId, partyId: custB, reason: "Paid up", userId }));
    const p = await partyRow(custB);
    expect(p.creditStatus).toBe("OK");
    const events = await holdEvents(custB);
    expect(events.map((e) => e.action)).toEqual(["HOLD", "RELEASE"]);
    expect(events[1]!.reason).toBe("Paid up");
  });
});

// ─── hard stop ───────────────────────────────────────────────────────

describe("23.6 assertCreditOk", () => {
  it("throws CreditHoldError (409 CREDIT_ON_HOLD) for a held party", async () => {
    const p = await partyRow(custC); // held by the utilization rule
    expect(() => assertCreditOk(p)).toThrow(CreditHoldError);
    try {
      assertCreditOk(p);
    } catch (e) {
      expect(e).toBeInstanceOf(CreditHoldError);
      expect((e as CreditHoldError).status).toBe(409);
      expect((e as CreditHoldError).code).toBe("CREDIT_ON_HOLD");
    }
  });

  it("never blocks a fully-paid cash sale", async () => {
    const p = await partyRow(custC);
    expect(() => assertCreditOk(p, { newCreditPaisa: 0n })).not.toThrow();
    expect(() => assertCreditOk(p, { newCreditPaisa: -100n })).not.toThrow();
  });

  it("passes an OK party", async () => {
    const p = await partyRow(custB);
    expect(() => assertCreditOk(p)).not.toThrow();
  });
});

// ─── collection priority ─────────────────────────────────────────────

describe("23.7 collectionPriority", () => {
  it("ranks riskiest first and skips customers with nothing open", async () => {
    // Re-add an overdue invoice for custA so it ranks HIGH again.
    await addInvoice(custA, { daysAgo: 120, grandTotal: 60_000n });
    const list = await collectionPriority(db, companyId, NOW);
    const ids = list.map((c) => c.partyId);
    expect(ids).toContain(custA);
    expect(ids).toContain(custC);
    expect(ids).toContain(custB);
    // HIGH before LOW (custB is LOW with a 5-day invoice).
    expect(ids.indexOf(custA)).toBeLessThan(ids.indexOf(custB));
    // custC is on hold by the utilization rule.
    expect(list.find((c) => c.partyId === custC)!.onHold).toBe(true);
    // Outstanding is a string of paisa.
    expect(BigInt(list.find((c) => c.partyId === custA)!.totalOutstanding)).toBeGreaterThan(0n);
  });
});
