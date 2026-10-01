/**
 * Module 15 — Notification Engine & Third-Party Gateways.
 *
 * Covers: reminder template rendering, rule matching by day offset
 * (before-due / due-date / overdue boundaries), idempotent dispatch
 * (no duplicate reminders for the same invoice+rule+day), channel
 * behaviour (email graceful-skip without RESEND_API_KEY, WhatsApp queue
 * with trackable wa.me links), in-app notification entries, rule CRUD
 * scoping, low-stock trigger boundary + daily dedupe, and cross-company
 * isolation of the whole engine.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import * as s from "@/db/schema";
import {
  ensureDefaultReminderRules,
  findOpenInvoices,
  runPaymentReminders,
  renderReminderTemplate,
  defaultTemplate,
  daysPastDue,
  toTriggerDate,
} from "@/lib/reminders";
import { findLowStockProducts, runLowStockCheck } from "@/lib/low-stock";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const R = (rs: number) => BigInt(rs) * 100n;

let branchId = "";
let otherBranchId = "";
let customerId = "";
let customerNoEmailId = "";
let otherCustomerId = "";
let productId = "";
let productOkId = "";

const AS_OF = new Date(Date.UTC(2026, 9, 1, 12, 0, 0)); // 2026-10-01
const dueIn = (days: number) =>
  new Date(Date.UTC(2026, 9, 1 + days, 12, 0, 0)); // asOf + days

async function makeInvoice(opts: {
  cid?: string;
  partyId?: string;
  due: Date;
  total?: bigint;
  paid?: bigint;
  status?: string;
  email?: boolean;
}): Promise<string> {
  const cid = opts.cid ?? companyId;
  const id = crypto.randomUUID();
  const docNo = `INV-T15-${id.slice(0, 8)}`;
  await db.insert(s.salesDocs).values({
    id,
    companyId: cid,
    branchId: cid === companyId ? branchId : otherBranchId,
    partyId: opts.partyId ?? (cid === companyId ? customerId : otherCustomerId),
    docType: "INVOICE",
    docNo,
    date: dueIn(-30),
    dueDate: opts.due,
    status: opts.status ?? "POSTED",
    subtotal: opts.total ?? R(1000),
    grandTotal: opts.total ?? R(1000),
    amountPaid: opts.paid ?? 0n,
    createdById: userId,
  });
  return id;
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  ({ branchId } = await setupCompany(db, companyId));
  ({ branchId: otherBranchId } = await setupCompany(db, otherCompanyId));
  await db.insert(s.companies).values({ id: companyId, name: "T15 Test Co", email: "shop@example.com" });
  await db.insert(s.companies).values({ id: otherCompanyId, name: "T15 Other Co" });

  await db.insert(s.parties).values({
    id: (customerId = crypto.randomUUID()),
    companyId, kind: "CUSTOMER", name: "T15 Customer", email: "cust@example.com", phone: "03001234567",
  });
  await db.insert(s.parties).values({
    id: (customerNoEmailId = crypto.randomUUID()),
    companyId, kind: "CUSTOMER", name: "T15 NoEmail", phone: "03007654321",
  });
  await db.insert(s.parties).values({
    id: (otherCustomerId = crypto.randomUUID()),
    companyId: otherCompanyId, kind: "CUSTOMER", name: "T15 Other Co Customer",
  });

  // Low-stock fixtures: reorder level 10 units (milli-units).
  await db.insert(s.products).values({
    id: (productId = crypto.randomUUID()), companyId, sku: "T15-LOW", name: "T15 Low Item",
    unit: "PCS", reorderLevel: 10000n, trackStock: true,
  });
  await db.insert(s.products).values({
    id: (productOkId = crypto.randomUUID()), companyId, sku: "T15-OK", name: "T15 Ok Item",
    unit: "PCS", reorderLevel: 10000n, trackStock: true,
  });
});

afterAll(() => cleanup());

describe("reminder templates", () => {
  it("renders every placeholder", () => {
    const out = renderReminderTemplate("{{business_name}} {{party_name}} {{invoice_no}} {{amount_due}} {{due_date}} {{days_overdue}} {{payment_link}}", {
      business_name: "Shop", party_name: "Ali", invoice_no: "INV-1",
      amount_due: "Rs 1,000.00", due_date: "01 Oct 2026", days_overdue: 7,
      payment_link: "https://x/pay/1",
    });
    expect(out).toBe("Shop Ali INV-1 Rs 1,000.00 01 Oct 2026 7 https://x/pay/1");
  });
  it("leaves unknown placeholders untouched", () => {
    const out = renderReminderTemplate("Hi {{party_name}}, {{typo_here}}", {
      business_name: "", party_name: "Ali", invoice_no: "", amount_due: "",
      due_date: "", days_overdue: 0, payment_link: "",
    });
    expect(out).toBe("Hi Ali, {{typo_here}}");
  });
  it("built-in templates exist for all kinds", () => {
    for (const k of ["BEFORE_DUE", "DUE_DATE", "OVERDUE"] as const) {
      const t = defaultTemplate(k);
      expect(t).toContain("{{party_name}}");
      expect(t).toContain("{{invoice_no}}");
      expect(t).toContain("{{amount_due}}");
    }
    expect(defaultTemplate("OVERDUE")).toContain("{{days_overdue}}");
  });
  it("daysPastDue is exact on boundaries", () => {
    expect(daysPastDue(dueIn(3), AS_OF)).toBe(-3);
    expect(daysPastDue(dueIn(0), AS_OF)).toBe(0);
    expect(daysPastDue(dueIn(-7), AS_OF)).toBe(7);
    expect(toTriggerDate(AS_OF)).toBe("2026-10-01");
  });
});

describe("default rules", () => {
  it("seeds exactly the 4 spec rules, idempotently", async () => {
    const first = await ensureDefaultReminderRules(db, companyId);
    expect(first).toHaveLength(4);
    const offsets = first.map((r) => r.daysOffset).sort((a, b) => a - b);
    expect(offsets).toEqual([-3, 0, 7, 15]);
    const second = await ensureDefaultReminderRules(db, companyId);
    expect(second).toHaveLength(4);
    const rows = await db.select().from(s.reminderRules).where(eq(s.reminderRules.companyId, companyId));
    expect(rows).toHaveLength(4);
  });
});

describe("rule matching by day offset", () => {
  it("matches only the rule whose offset equals days-past-due", async () => {
    // Invoice due in exactly 3 days → BEFORE_DUE(-3) only.
    const invId = await makeInvoice({ due: dueIn(3) });
    const res = await runPaymentReminders(db, { companyId, asOf: AS_OF, baseUrl: "https://x.test" });
    expect(res.scanned).toBeGreaterThanOrEqual(1);
    expect(res.matched).toBe(1);
    expect(res.dispatched).toBe(1);
    const logs = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, invId)
    ));
    expect(logs).toHaveLength(1);
    const [rule] = await db.select().from(s.reminderRules).where(eq(s.reminderRules.id, logs[0].ruleId));
    expect(rule.daysOffset).toBe(-3);
  });

  it("due-date invoice matches offset 0; 8-days-overdue matches nothing", async () => {
    const dueToday = await makeInvoice({ due: dueIn(0), partyId: customerNoEmailId });
    const eightOverdue = await makeInvoice({ due: dueIn(-8), partyId: customerNoEmailId });
    await runPaymentReminders(db, { companyId, asOf: AS_OF });
    // due-today invoice matches exactly one rule; the 8-day one matches none.
    const logsToday = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, dueToday)
    ));
    expect(logsToday).toHaveLength(1);
    const logs8 = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, eightOverdue)
    ));
    expect(logs8).toHaveLength(0);
    // (earlier tests' invoices re-match as duplicates, so only per-invoice log counts are asserted)
  });

  it("skips DRAFT, PAID and fully-paid invoices", async () => {
    const draftId = await makeInvoice({ due: dueIn(0), status: "DRAFT", partyId: customerNoEmailId });
    const paidId = await makeInvoice({ due: dueIn(0), status: "PAID", partyId: customerNoEmailId });
    const settledId = await makeInvoice({ due: dueIn(0), total: R(500), paid: R(500), partyId: customerNoEmailId });
    await runPaymentReminders(db, { companyId, asOf: AS_OF });
    for (const id of [draftId, paidId, settledId]) {
      const logs = await db.select().from(s.reminderLog).where(and(
        eq(s.reminderLog.companyId, companyId),
        eq(s.reminderLog.invoiceId, id)
      ));
      expect(logs).toHaveLength(0);
    }
  });
});

describe("idempotent dispatch", () => {
  it("running twice the same day sends once; the second run only reports duplicates", async () => {
    const invId = await makeInvoice({ due: dueIn(-7), partyId: customerNoEmailId });
    const first = await runPaymentReminders(db, { companyId, asOf: AS_OF });
    expect(first.dispatched).toBeGreaterThanOrEqual(1);
    const second = await runPaymentReminders(db, { companyId, asOf: AS_OF });
    expect(second.dispatched).toBe(0);
    expect(second.duplicates).toBeGreaterThanOrEqual(1);
    const logs = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, invId)
    ));
    expect(logs).toHaveLength(1);
  });

  it("disabled rules never fire", async () => {
    const invId = await makeInvoice({ due: dueIn(-15), partyId: customerNoEmailId });
    // Disable the OVERDUE(15) rule.
    const rules = await db.select().from(s.reminderRules).where(eq(s.reminderRules.companyId, companyId));
    const r15 = rules.find((r) => r.daysOffset === 15)!;
    await db.update(s.reminderRules).set({ enabled: false }).where(eq(s.reminderRules.id, r15.id));
    await runPaymentReminders(db, { companyId, asOf: AS_OF });
    const logs = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, invId)
    ));
    expect(logs).toHaveLength(0);
    // Re-enable for the other tests.
    await db.update(s.reminderRules).set({ enabled: true }).where(eq(s.reminderRules.id, r15.id));
  });
});

describe("channels", () => {
  it("emails without a RESEND key are gracefully skipped, WhatsApp queued with a wa.me link", async () => {
    const invId = await makeInvoice({ due: dueIn(0), partyId: customerId }); // has email + phone
    const res = await runPaymentReminders(db, { companyId, asOf: AS_OF });
    expect(res.emailSkipped).toBeGreaterThanOrEqual(1); // no RESEND_API_KEY in tests
    expect(res.emailSent).toBe(0);
    expect(res.whatsappQueued).toBeGreaterThanOrEqual(1);
    const [q] = await db.select().from(s.whatsappQueue).where(and(
      eq(s.whatsappQueue.companyId, companyId),
      eq(s.whatsappQueue.invoiceId, invId)
    ));
    expect(q).toBeTruthy();
    expect(q.status).toBe("QUEUED");
    expect(q.waLink).toContain("https://wa.me/923001234567");
    expect(q.waLink).toContain("text=");
    expect(q.message).toContain("INV-T15-");
    const [log] = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, invId)
    ));
    expect(log.emailSkipped).toBe(true);
    expect(log.whatsappQueued).toBe(true);
  });

  it("every dispatched reminder creates an in-app notification", async () => {
    const invId = await makeInvoice({ due: dueIn(3), partyId: customerNoEmailId });
    await runPaymentReminders(db, { companyId, asOf: AS_OF });
    const notifs = await db.select().from(s.notifications).where(and(
      eq(s.notifications.companyId, companyId),
      eq(s.notifications.kind, "REMINDER"),
      eq(s.notifications.entityId, invId)
    ));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].isRead).toBe(false);
    expect(notifs[0].link).toContain(invId);
  });
});

describe("cross-company isolation", () => {
  it("a run for company A never touches company B's invoices", async () => {
    const otherInv = await makeInvoice({ cid: otherCompanyId, due: dueIn(0) });
    await runPaymentReminders(db, { companyId, asOf: AS_OF });
    const logs = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, companyId),
      eq(s.reminderLog.invoiceId, otherInv)
    ));
    expect(logs).toHaveLength(0);
    // Company B's own run picks it up.
    const resB = await runPaymentReminders(db, { companyId: otherCompanyId, asOf: AS_OF });
    expect(resB.dispatched).toBe(1);
    const logsB = await db.select().from(s.reminderLog).where(and(
      eq(s.reminderLog.companyId, otherCompanyId),
      eq(s.reminderLog.invoiceId, otherInv)
    ));
    expect(logsB).toHaveLength(1);
  });

  it("findOpenInvoices is tenant-scoped", async () => {
    const mine = await findOpenInvoices(db, companyId);
    const theirs = await findOpenInvoices(db, otherCompanyId);
    expect(mine.every((i) => i.partyName !== "T15 Other Co Customer")).toBe(true);
    expect(theirs.length).toBeGreaterThanOrEqual(1);
  });
});

describe("low-stock engine", () => {
  beforeAll(async () => {
    // productId: 4 + 6 = 10 units on hand == reorder level 10 → triggers (boundary).
    await db.insert(s.stockLevels).values({ id: crypto.randomUUID(), productId, branchId, qty: 4000n, avgCost: R(50) });
    const b2 = crypto.randomUUID();
    await db.insert(s.branches).values({ id: b2, companyId, name: "T15 Branch 2" });
    await db.insert(s.stockLevels).values({ id: crypto.randomUUID(), productId, branchId: b2, qty: 6000n, avgCost: R(50) });
    // productOkId: 11 units > reorder level 10 → no alert.
    await db.insert(s.stockLevels).values({ id: crypto.randomUUID(), productId: productOkId, branchId, qty: 11000n, avgCost: R(50) });
  });

  it("triggers exactly at the reorder level, not above (boundary)", async () => {
    const low = await findLowStockProducts(db, companyId);
    const hit = low.find((p) => p.productId === productId);
    expect(hit).toBeTruthy();
    expect(hit!.onHand).toBe(10000n);
    expect(hit!.reorderLevel).toBe(10000n);
    expect(low.find((p) => p.productId === productOkId)).toBeUndefined();
  });

  it("creates notifications once per product per day (dedupe)", async () => {
    const first = await runLowStockCheck(db, companyId, { asOf: AS_OF });
    expect(first.low).toBe(1);
    expect(first.notified).toBe(1);
    const second = await runLowStockCheck(db, companyId, { asOf: AS_OF });
    expect(second.notified).toBe(0);
    expect(second.deduped).toBe(1);
    const notifs = await db.select().from(s.notifications).where(and(
      eq(s.notifications.companyId, companyId),
      eq(s.notifications.kind, "LOW_STOCK"),
      eq(s.notifications.entityId, productId)
    ));
    expect(notifs).toHaveLength(1);
    expect(notifs[0].link).toContain("lowStock=1");
  });

  it("is tenant-scoped", async () => {
    const low = await findLowStockProducts(db, otherCompanyId);
    expect(low).toHaveLength(0);
  });
});
