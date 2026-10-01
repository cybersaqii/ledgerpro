/**
 * Module 24 — recurring invoices.
 *
 * Covers: advanceRunDate calendar math (month-end clamping); template CRUD
 * validation (bad frequency, blank name, end-before-start, inactive party);
 * pause / resume / skipNextRun; runDueTemplates generation (posts a real
 * invoice, writes the GENERATED run row, advances the cursor), idempotency
 * (re-running the same period is a no-op), skip_next (SKIPPED row, flag
 * cleared, no invoice), credit-hold refusal (failed, no run row so the next
 * cron tick retries), and paused templates being ignored.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { insertParty } from "@/lib/party-create";
import { parseMoney } from "@/lib/money";
import * as s from "@/db/schema";
import {
  advanceRunDate,
  createRecurringTemplate,
  getTemplate,
  listTemplates,
  setTemplateStatus,
  skipNextRun,
  deleteTemplate,
  updateRecurringTemplate,
  templateRuns,
  runDueTemplates,
} from "@/lib/recurring";
import { placeCreditHold } from "@/lib/credit-control";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = "test-user";
let branchId = "";
let customer = "";
let inactiveCustomer = "";
let product = "";

const NOW = Date.UTC(2026, 5, 15, 12); // 2026-06-15 noon UTC
const day = 86_400_000;

async function makeTemplate(over: Record<string, unknown> = {}) {
  return db.transaction((tx) =>
    createRecurringTemplate(
      tx,
      companyId,
      {
        branchId,
        partyId: customer,
        name: "M24 Rent",
        frequency: "MONTHLY",
        startDateMs: NOW - 2 * day,
        endDateMs: null,
        notes: null,
        items: [{ productId: product, qty: 1, ratePaisa: parseMoney("5000").toString() }],
        ...over,
      } as never,
      userId
    )
  );
}

async function runRows(templateId: string) {
  return db
    .select()
    .from(s.recurringRuns)
    .where(and(eq(s.recurringRuns.companyId, companyId), eq(s.recurringRuns.templateId, templateId)));
}

async function invoicesFor(partyId: string) {
  return db
    .select()
    .from(s.salesDocs)
    .where(
      and(
        eq(s.salesDocs.companyId, companyId),
        eq(s.salesDocs.partyId, partyId),
        eq(s.salesDocs.docType, "INVOICE")
      )
    );
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "M24 Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M24 Customer" } })
  ));
  ({ id: inactiveCustomer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M24 Inactive" } })
  ));
  await db.update(s.parties).set({ isActive: false }).where(eq(s.parties.id, inactiveCustomer));

  product = crypto.randomUUID();
  await db.insert(s.products).values({
    id: product,
    companyId,
    sku: "M24-RENT",
    name: "M24 Monthly Rent",
    unit: "JOB",
    purchasePrice: parseMoney("0"),
    salePrice: parseMoney("5000"),
    trackStock: false, // service-style: no stock moves on generation
  });
});

afterAll(() => cleanup());

// ─── calendar math ───────────────────────────────────────────────────

describe("24.1 advanceRunDate", () => {
  it("clamps month-end (Jan 31 → Feb 28)", () => {
    expect(advanceRunDate(Date.UTC(2026, 0, 31), "MONTHLY")).toBe(Date.UTC(2026, 1, 28));
  });
  it("keeps mid-month days stable", () => {
    expect(advanceRunDate(Date.UTC(2026, 0, 15), "MONTHLY")).toBe(Date.UTC(2026, 1, 15));
  });
  it("adds a week / day", () => {
    expect(advanceRunDate(NOW, "WEEKLY")).toBe(NOW + 7 * day);
    expect(advanceRunDate(NOW, "DAILY")).toBe(NOW + day);
  });
  it("adds quarters and years", () => {
    expect(advanceRunDate(Date.UTC(2026, 0, 15), "QUARTERLY")).toBe(Date.UTC(2026, 3, 15));
    expect(advanceRunDate(Date.UTC(2026, 0, 15), "YEARLY")).toBe(Date.UTC(2027, 0, 15));
  });
});

// ─── template CRUD ───────────────────────────────────────────────────

describe("24.2 template validation", () => {
  it("rejects a bad frequency, blank name, and end-before-start", async () => {
    await expect(
      db.transaction((tx) =>
        createRecurringTemplate(tx, companyId, {
          branchId, partyId: customer, name: "x", frequency: "FORTNIGHTLY" as never,
          startDateMs: NOW, endDateMs: null, items: [{ productId: product, qty: 1, ratePaisa: "100" }],
        }, userId)
      )
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) =>
        createRecurringTemplate(tx, companyId, {
          branchId, partyId: customer, name: "   ", frequency: "MONTHLY",
          startDateMs: NOW, endDateMs: null, items: [{ productId: product, qty: 1, ratePaisa: "100" }],
        }, userId)
      )
    ).rejects.toThrow();
    await expect(
      db.transaction((tx) =>
        createRecurringTemplate(tx, companyId, {
          branchId, partyId: customer, name: "x", frequency: "MONTHLY",
          startDateMs: NOW, endDateMs: NOW - day, items: [{ productId: product, qty: 1, ratePaisa: "100" }],
        }, userId)
      )
    ).rejects.toThrow();
  });

  it("rejects an inactive / non-customer party", async () => {
    await expect(
      db.transaction((tx) =>
        createRecurringTemplate(tx, companyId, {
          branchId, partyId: inactiveCustomer, name: "x", frequency: "MONTHLY",
          startDateMs: NOW, endDateMs: null, items: [{ productId: product, qty: 1, ratePaisa: "100" }],
        }, userId)
      )
    ).rejects.toThrow();
  });

  it("creates an ACTIVE template with the cursor on the start date", async () => {
    const id = await makeTemplate();
    const t = await getTemplate(db, companyId, id);
    expect(t!.status).toBe("ACTIVE");
    expect(t!.nextRunDate.getTime()).toBe(NOW - 2 * day);
    expect(t!.skipNext).toBe(false);
    const list = await listTemplates(db, companyId);
    expect(list.some((r) => r.template.id === id)).toBe(true);
  });

  it("pauses, resumes, and skips the next run", async () => {
    const id = await makeTemplate({ name: "M24 Lifecycle" });
    await db.transaction((tx) => setTemplateStatus(tx, companyId, id, "PAUSED"));
    expect((await getTemplate(db, companyId, id))!.status).toBe("PAUSED");
    await db.transaction((tx) => setTemplateStatus(tx, companyId, id, "ACTIVE"));
    expect((await getTemplate(db, companyId, id))!.status).toBe("ACTIVE");
    await db.transaction((tx) => skipNextRun(tx, companyId, id));
    expect((await getTemplate(db, companyId, id))!.skipNext).toBe(true);
  });

  it("updates the name and items", async () => {
    const id = await makeTemplate({ name: "M24 Rename" });
    await db.transaction((tx) =>
      updateRecurringTemplate(tx, companyId, id, { name: "M24 Renamed" })
    );
    expect((await getTemplate(db, companyId, id))!.name).toBe("M24 Renamed");
  });

  it("deletes a template", async () => {
    const id = await makeTemplate({ name: "M24 Doomed" });
    await db.transaction((tx) => deleteTemplate(tx, companyId, id));
    expect(await getTemplate(db, companyId, id)).toBeNull();
  });
});

// ─── generation ──────────────────────────────────────────────────────

describe("24.3 runDueTemplates", () => {
  // Templates from 24.2 are still ACTIVE and due — park them so each
  // generation test below sees exactly the template it created.
  beforeAll(async () => {
    const list = await listTemplates(db, companyId);
    for (const r of list) {
      await db.transaction((tx) => setTemplateStatus(tx, companyId, r.template.id, "PAUSED"));
    }
  });

  it("generates a posted invoice, a GENERATED run row, and advances the cursor", async () => {
    const id = await makeTemplate({ name: "M24 Gen" });
    const before = await invoicesFor(customer);
    const summary = await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    expect(summary.generated).toBeGreaterThanOrEqual(1);
    const after = await invoicesFor(customer);
    expect(after.length).toBe(before.length + 1);
    const inv = after[after.length - 1]!;
    expect(inv.grandTotal).toBe(parseMoney("5000"));
    expect(inv.status).toBe("POSTED");
    expect(inv.notes).toContain("M24 Gen");

    const runs = await runRows(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("GENERATED");
    expect(runs[0]!.salesDocId).toBe(inv.id);

    const t = await getTemplate(db, companyId, id);
    expect(t!.nextRunDate.getTime()).toBeGreaterThan(NOW - 2 * day);

    // Idempotent: a second run finds nothing due (cursor already advanced).
    const again = await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    expect((await runRows(id)).length).toBe(1);
    expect((await invoicesFor(customer)).length).toBe(after.length);
    expect(again.templates).toBe(0);
  });

  it("skip_next writes a SKIPPED row, clears the flag, invoices nothing", async () => {
    const id = await makeTemplate({ name: "M24 Skip" });
    await db.transaction((tx) => skipNextRun(tx, companyId, id));
    const before = await invoicesFor(customer);
    const summary = await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    expect(summary.skipped).toBeGreaterThanOrEqual(1);
    expect((await invoicesFor(customer)).length).toBe(before.length);
    const runs = await runRows(id);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("SKIPPED");
    expect((await getTemplate(db, companyId, id))!.skipNext).toBe(false);
  });

  it("refuses when the customer is on credit hold — failed, no run row (retryable)", async () => {
    const id = await makeTemplate({ name: "M24 Hold" });
    await db.transaction((tx) =>
      placeCreditHold(tx, { companyId, partyId: customer, reason: "M24 test hold", userId })
    );
    const summary = await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    expect(summary.failed).toBeGreaterThanOrEqual(1);
    expect(summary.failures.some((f) => f.templateId === id && /credit hold/i.test(f.reason))).toBe(true);
    // No run row was written, so the next cron tick retries the same period.
    expect(await runRows(id)).toHaveLength(0);
    // Release the hold and park the template for the remaining tests.
    const { releaseCreditHold } = await import("@/lib/credit-control");
    await db.transaction((tx) => releaseCreditHold(tx, { companyId, partyId: customer, reason: "test done", userId }));
    await db.transaction((tx) => setTemplateStatus(tx, companyId, id, "PAUSED"));
  });

  it("ignores paused templates", async () => {
    const id = await makeTemplate({ name: "M24 Paused" });
    await db.transaction((tx) => setTemplateStatus(tx, companyId, id, "PAUSED"));
    const before = await invoicesFor(customer);
    const summary = await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    expect(summary.templates).toBe(0);
    expect(await runRows(id)).toHaveLength(0);
    expect((await invoicesFor(customer)).length).toBe(before.length);
  });

  it("templateRuns returns newest-first history", async () => {
    const id = await makeTemplate({ name: "M24 History" });
    await runDueTemplates(db, { companyId, asOfMs: NOW, actor: "TEST" });
    const runs = await templateRuns(db, companyId, id);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    expect(runs[0]!.run.status).toBe("GENERATED");
  });
});
