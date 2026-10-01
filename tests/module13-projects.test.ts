/**
 * Module 13 — Projects & Job Costing.
 *
 * Covers: project CRUD + PRJ-0001 sequencing, validation (name/budget/
 * dates/customer), status transition guards + terminal states, tagging
 * validation (foreign company, CANCELLED), job-cost P&L from tagged journal
 * lines (revenue from INCOME, cost from EXPENSE, payments P&L-neutral),
 * untagged docs excluded, void nets the P&L back to zero, WIP-by-project via
 * the 1250 account, date-range filtering, tagged-doc listing, and company
 * isolation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { postExpense, postPayment, postSalesDoc } from "@/lib/posting";
import { postManualJournal } from "@/lib/journal-vouchers";
import { voidExpense } from "@/lib/payment-void";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import * as s from "@/db/schema";
import {
  createProject,
  updateProject,
  getProject,
  listProjects,
  validateProjectId,
  projectPL,
  taggedDocs,
} from "@/lib/projects";
import { posCheckoutSchema } from "@/lib/validators";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
const R = (rs: number) => BigInt(rs) * 100n; // rupees → paisa

let branchId = "";
let labourGl = ""; // EXPENSE account "Site Labour"
let cashGl = "";
let bankId = "";
let customerId = "";

async function makeProject(name = "Site A Tower") {
  return db.transaction((tx) =>
    createProject(tx, { companyId, name, createdById: userId })
  );
}

async function postTaggedExpense(projectId: string | null, amountRs: number, date = new Date()): Promise<string> {
  return db.transaction((tx) =>
    postExpense(tx, {
      companyId, branchId, accountId: labourGl, bankAccountId: bankId,
      date, amount: R(amountRs), taxAmount: 0n,
      notes: "test expense", createdById: userId,
      projectId,
    })
  );
}

/** A service-style invoice (no stock) tagged to a project. */
async function postTaggedSale(projectId: string | null, amountRs: number, date = new Date()): Promise<void> {
  const items: DocItemInput[] = [
    { productId: null, description: "Contract work", qtyMilli: 1000n, ratePaisa: parseMoney(String(amountRs)), discountPaisa: 0n, taxBps: 0 },
  ];
  const totals = computeTotals(items, 0n);
  await db.transaction(async (tx) => {
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: customerId, docType: "INVOICE",
      docNo: `INV-${crypto.randomUUID().slice(0, 8)}`, date, status: "POSTED",
      subtotal: totals.subtotal, discountTotal: 0n, taxTotal: 0n,
      grandTotal: totals.grandTotal, createdById: userId, projectId,
    });
    await postSalesDoc(tx, {
      companyId, branchId, partyId: customerId, docId,
      docNo: "x", docType: "INVOICE", date,
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: 0n, grandTotal: totals.grandTotal,
      createdById: userId, projectId,
    });
  });
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  ({ branchId } = await setupCompany(db, companyId));
  const ac = await accountMap(db, companyId);
  // expense GL + cash GL + bank
  labourGl = crypto.randomUUID();
  await db.insert(s.accounts).values({ id: labourGl, companyId, code: "6290", name: "Site Labour", type: "EXPENSE" });
  cashGl = ac[SYS.CASH];
  bankId = crypto.randomUUID();
  await db.insert(s.bankAccounts).values({ id: bankId, companyId, name: "Cash Box", kind: "CASH", accountId: cashGl, balance: R(1_000_000) });
  customerId = crypto.randomUUID();
  await db.insert(s.parties).values({ id: customerId, companyId, kind: "CUSTOMER", name: "Site Client" });
});

afterAll(() => cleanup());

describe("project master", () => {
  it("creates projects with PRJ- codes in sequence, ACTIVE by default", async () => {
    const a = await makeProject("Tower A");
    const b = await makeProject("Tower B");
    expect(a.code).toBe("PRJ-0001");
    expect(b.code).toBe("PRJ-0002");
    expect(a.status).toBe("ACTIVE");
  });

  it("rejects bad input with stable codes", async () => {
    await expect(db.transaction((tx) => createProject(tx, { companyId, name: "  ", createdById: userId })))
      .rejects.toMatchObject({ code: "PROJECT_NAME_REQUIRED" });
    await expect(db.transaction((tx) => createProject(tx, { companyId, name: "X", budgetPaisa: -1n, createdById: userId })))
      .rejects.toMatchObject({ code: "PROJECT_NEG_BUDGET" });
    await expect(db.transaction((tx) => createProject(tx, {
      companyId, name: "X", createdById: userId,
      startDate: new Date("2026-05-01"), endDate: new Date("2026-04-01"),
    }))).rejects.toMatchObject({ code: "PROJECT_BAD_DATES" });
    await expect(db.transaction((tx) => createProject(tx, { companyId, name: "X", customerId: crypto.randomUUID(), createdById: userId })))
      .rejects.toMatchObject({ code: "PROJECT_CUSTOMER_NOT_FOUND" });
  });

  it("links a customer and lists projects with the customer name", async () => {
    const p = await db.transaction((tx) =>
      createProject(tx, { companyId, name: "Linked", customerId, contractValuePaisa: R(500000), budgetPaisa: R(300000), createdById: userId })
    );
    expect(p.contractValue).toBe(R(500000));
    const rows = await listProjects(db, companyId);
    const found = rows.find((r) => r.id === p.id)!;
    expect(found.customerName).toBe("Site Client");
    const fetched = await getProject(db, companyId, p.id);
    expect(fetched.name).toBe("Linked");
  });
});

describe("status transitions", () => {
  it("allows ACTIVE → ON_HOLD → ACTIVE → COMPLETED", async () => {
    const p = await makeProject("Lifecycle");
    let u = await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "ON_HOLD" }));
    expect(u.status).toBe("ON_HOLD");
    u = await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "ACTIVE" }));
    expect(u.status).toBe("ACTIVE");
    u = await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "COMPLETED" }));
    expect(u.status).toBe("COMPLETED");
  });

  it("terminal statuses never move again", async () => {
    const p = await makeProject("Done");
    await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "COMPLETED" }));
    await expect(db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "ACTIVE" })))
      .rejects.toMatchObject({ code: "PROJECT_STATUS_TERMINAL" });
    const c = await makeProject("Scrapped");
    await db.transaction((tx) => updateProject(tx, companyId, c.id, { status: "CANCELLED" }));
    await expect(db.transaction((tx) => updateProject(tx, companyId, c.id, { status: "ON_HOLD" })))
      .rejects.toMatchObject({ code: "PROJECT_STATUS_TERMINAL" });
  });

  it("rejects unknown statuses", async () => {
    const p = await makeProject("Weird");
    await expect(db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "WHATEVER" as never })))
      .rejects.toMatchObject({ code: "PROJECT_BAD_STATUS" });
  });
});

describe("tag validation", () => {
  it("accepts ACTIVE/ON_HOLD/COMPLETED, rejects CANCELLED", async () => {
    const p = await makeProject("Taggable");
    await expect(validateProjectId(db, companyId, p.id)).resolves.toBe(p.id);
    await expect(validateProjectId(db, companyId, null)).resolves.toBeNull();
    await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "COMPLETED" }));
    await expect(validateProjectId(db, companyId, p.id)).resolves.toBe(p.id);
    // COMPLETED is terminal, so the CANCELLED case uses a fresh project.
    const c = await makeProject("Cancelled");
    await db.transaction((tx) => updateProject(tx, companyId, c.id, { status: "CANCELLED" }));
    await expect(validateProjectId(db, companyId, c.id)).rejects.toMatchObject({ code: "PROJECT_CANCELLED" });
  });

  it("rejects foreign-company projects and unknown ids", async () => {
    const otherCompany = crypto.randomUUID();
    await setupCompany(db, otherCompany);
    const foreign = await db.transaction((tx) =>
      createProject(tx, { companyId: otherCompany, name: "Foreign", createdById: userId })
    );
    await expect(validateProjectId(db, companyId, foreign.id)).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    await expect(validateProjectId(db, companyId, crypto.randomUUID())).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });
    // and listProjects never leaks across companies
    const mine = await listProjects(db, companyId);
    expect(mine.some((r) => r.id === foreign.id)).toBe(false);
  });
});

describe("job-cost P&L", () => {
  it("builds revenue from tagged sales and cost from tagged expenses", async () => {
    const p = await makeProject("P&L Basic");
    await postTaggedSale(p.id, 200000); // revenue Rs 200,000
    await postTaggedExpense(p.id, 60000); // cost Rs 60,000
    await postTaggedExpense(null, 10000); // untagged — must not count
    const pl = await projectPL(db, companyId, p.id);
    expect(pl.revenue).toBe(R(200000));
    expect(pl.cost).toBe(R(60000));
    expect(pl.profit).toBe(R(140000));
    expect(pl.costByAccount).toHaveLength(1);
    expect(pl.costByAccount[0]).toMatchObject({ code: "6290", name: "Site Labour", amount: R(60000) });
  });

  it("is P&L-neutral for tagged payments (AR/Bank only)", async () => {
    const p = await makeProject("Payment Neutral");
    await postTaggedSale(p.id, 50000);
    await db.transaction(async (tx) => {
      const pid = await validateProjectId(tx, companyId, p.id);
      await postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customerId,
        bankAccountId: bankId, date: new Date(), amount: R(50000),
        method: "CASH", createdById: userId, projectId: pid,
        allocations: [],
      });
    });
    const pl = await projectPL(db, companyId, p.id);
    expect(pl.revenue).toBe(R(50000));
    expect(pl.cost).toBe(0n);
    // but the payment IS listed among tagged documents
    const docs = await taggedDocs(db, companyId, p.id);
    expect(docs.some((d) => d.kind === "PAYMENT")).toBe(true);
  });

  it("voiding a tagged expense nets its cost back to zero", async () => {
    const p = await makeProject("Void Net");
    const expenseId = await postTaggedExpense(p.id, 25000);
    let pl = await projectPL(db, companyId, p.id);
    expect(pl.cost).toBe(R(25000));
    await db.transaction((tx) => voidExpense(tx, { companyId, expenseId, userId }));
    pl = await projectPL(db, companyId, p.id);
    expect(pl.cost).toBe(0n);
  });

  it("slices WIP-by-project from the 1250 account", async () => {
    const p = await makeProject("WIP Slice");
    const ac = await accountMap(db, companyId);
    await db.transaction(async (tx) => {
      const pid = await validateProjectId(tx, companyId, p.id);
      await postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "WIP material",
        lines: [
          { accountId: ac[SYS.WIP], debit: R(90000), credit: 0n },
          { accountId: cashGl, debit: 0n, credit: R(90000) },
        ],
        createdById: userId, projectId: pid,
      });
    });
    const pl = await projectPL(db, companyId, p.id);
    expect(pl.wip).toBe(R(90000));
    // WIP is a balance-sheet account — it never leaks into cost/profit
    expect(pl.cost).toBe(0n);
    expect(pl.profit).toBe(0n);
  });

  it("respects the date range", async () => {
    const p = await makeProject("Dated");
    await postTaggedExpense(p.id, 10000, new Date("2026-01-10T00:00:00Z"));
    await postTaggedExpense(p.id, 20000, new Date("2026-03-10T00:00:00Z"));
    const jan = await projectPL(db, companyId, p.id, new Date("2026-01-01"), new Date("2026-01-31"));
    expect(jan.cost).toBe(R(10000));
    const all = await projectPL(db, companyId, p.id);
    expect(all.cost).toBe(R(30000));
  });

  it("lists tagged documents newest-first with totals", async () => {
    const p = await makeProject("Doc List");
    await postTaggedSale(p.id, 100000, new Date("2026-02-01T00:00:00Z"));
    await postTaggedExpense(p.id, 40000, new Date("2026-02-05T00:00:00Z"));
    const docs = await taggedDocs(db, companyId, p.id);
    expect(docs).toHaveLength(2);
    expect(docs[0].kind).toBe("EXPENSE");
    expect(docs[1].kind).toBe("SALE");
    expect(docs[1].total).toBe(R(100000));
    expect(docs[0].total).toBe(R(40000));
  });

  it("still reports a COMPLETED project", async () => {
    const p = await makeProject("Finished Job");
    await postTaggedSale(p.id, 80000);
    await db.transaction((tx) => updateProject(tx, companyId, p.id, { status: "COMPLETED" }));
    const pl = await projectPL(db, companyId, p.id);
    expect(pl.revenue).toBe(R(80000));
    expect(pl.status).toBe("COMPLETED");
  });

  it("reduces revenue when a tagged sales return debits INCOME", async () => {
    const p = await makeProject("Return Net");
    await postTaggedSale(p.id, 100000);
    const ac = await accountMap(db, companyId);
    await db.transaction(async (tx) => {
      const pid = await validateProjectId(tx, companyId, p.id);
      // mirrors what a sales return posts: Dr Sales Returns (INCOME) / Cr AR
      await postManualJournal(tx, {
        companyId, branchId, date: new Date(), memo: "tagged sales return",
        lines: [
          { accountId: ac[SYS.SALES_RETURN], debit: R(20000), credit: 0n },
          { accountId: ac[SYS.AR], debit: 0n, credit: R(20000), partyId: customerId },
        ],
        createdById: userId, projectId: pid,
      });
    });
    const pl = await projectPL(db, companyId, p.id);
    expect(pl.revenue).toBe(R(80000));
    expect(pl.profit).toBe(R(80000));
  });

  it("accepts projectId on the POS checkout schema (optional)", async () => {
    const item = { description: "POS item", qty: "1", rate: "100", discount: "0" };
    const tagged = posCheckoutSchema.safeParse({
      partyId: customerId, date: "2026-05-01", discountTotal: "0",
      items: [item], payments: [], projectId: "prj_1",
    });
    expect(tagged.success).toBe(true);
    if (tagged.success) expect(tagged.data.projectId).toBe("prj_1");
    const untagged = posCheckoutSchema.safeParse({
      partyId: customerId, date: "2026-05-01", discountTotal: "0",
      items: [item], payments: [],
    });
    expect(untagged.success).toBe(true);
    if (untagged.success) expect(untagged.data.projectId).toBeUndefined();
  });
});
