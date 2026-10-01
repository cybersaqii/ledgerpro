import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, nextDocNo, SYS } from "@/lib/setup";
import { postSalesDoc, postPurchaseDoc, postPayment } from "@/lib/posting";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { UserError } from "@/lib/errors";
import * as s from "@/db/schema";
import {
  buildFbrInvoicePayload,
  buildFbrQrData,
  fbrSyncStatus,
  attemptFbrSync,
  writeFbrConfig,
  readFbrConfig,
  readFbrPosId,
  paisaToRs,
} from "@/lib/fbr";
import { whtSectionRateBps, whtAmountPaisa } from "@/lib/wht";
import {
  listWhtDeductions,
  getWhtCertificateData,
  annexureCRows,
  annexureARows,
} from "@/lib/tax";
import { voidPayment } from "@/lib/payment-void";
import { voidPurchaseBill } from "@/lib/purchase-void";
import { voidSalesInvoice } from "@/lib/sales-void";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let bankId = "";
let supplierId = ""; // SERVICES, filer → 153-SERVICES 800bps
let customerId = ""; // filer customer
let productId = "";
let serviceId = "";

const day = new Date("2026-09-15T10:00:00Z");
const from = new Date("2026-09-01T00:00:00Z");
const to = new Date("2026-09-30T23:59:59Z");

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;

  supplierId = crypto.randomUUID();
  customerId = crypto.randomUUID();
  productId = crypto.randomUUID();
  serviceId = crypto.randomUUID();
  await db.insert(s.parties).values([
    {
      id: supplierId, companyId, kind: "SUPPLIER", name: "WHT Test Supplier",
      ntn: "7654321", whtCategory: "SERVICES", activeTaxPayer: true, filerStatus: "FILER",
    },
    {
      id: customerId, companyId, kind: "CUSTOMER", name: "WHT Test Customer",
      ntn: "1234567", filerStatus: "FILER",
    },
  ]);
  const [ba] = await db.select().from(s.bankAccounts).where(eq(s.bankAccounts.companyId, companyId)).limit(1);
  bankId = ba.id;
  await db.insert(s.products).values([
    {
      id: productId, companyId, sku: "M7WIDGET", name: "M7 Widget", unit: "PCS",
      purchasePrice: parseMoney("2000"), salePrice: parseMoney("2400"),
      trackStock: false, pctCode: "8471.30.00",
    },
    {
      id: serviceId, companyId, sku: "M7SERVICE", name: "M7 Service", unit: "JOB",
      purchasePrice: parseMoney("500"), salePrice: parseMoney("600"), trackStock: false,
    },
  ]);
});

afterAll(() => cleanup());

function salesItem(productId: string | null, qty: string, rate: string, taxBps = 0): DocItemInput {
  return {
    productId, description: "M7 test item", qtyMilli: parseQty(qty),
    ratePaisa: parseMoney(rate), discountPaisa: 0n, taxBps,
  };
}

/** Faithful lib-level posted sales invoice (mirrors app/api/sales/route.ts). */
async function postInvoice(opts: {
  customerId?: string; productId?: string | null; qty?: string; rate?: string; taxBps?: number;
}): Promise<{ docId: string; docNo: string; grandTotal: bigint; totals: ReturnType<typeof computeTotals> }> {
  const cid = opts.customerId ?? customerId;
  const totals = computeTotals(
    [salesItem(opts.productId ?? productId, opts.qty ?? "2", opts.rate ?? "1000", opts.taxBps ?? 0)],
    0n
  );
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId, companyId, branchId, partyId: cid, docType: "INVOICE",
      docNo, date: day, status: "POSTED", subtotal: totals.subtotal,
      discountTotal: 0n, taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.insert(s.salesDocItems).values(
      totals.items.map((i) => ({
        id: crypto.randomUUID(), docId, productId: i.productId, description: i.description,
        qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa,
        taxBps: i.taxBps, taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
      }))
    );
    const entryId = await postSalesDoc(tx, {
      companyId, branchId, partyId: cid, docId, docNo, docType: "INVOICE",
      date: day,
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: 0n, taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal, createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
    return { docId, docNo, grandTotal: totals.grandTotal, totals };
  });
}

/** Faithful lib-level posted purchase bill (mirrors app/api/purchases/route.ts). */
async function postBill(opts: {
  partyId?: string; qty?: string; rate?: string; taxBps?: number; whtBps?: number; whtSection?: string;
}): Promise<{ billId: string; docNo: string; totals: ReturnType<typeof computeTotals> }> {
  const partyId = opts.partyId ?? supplierId;
  const items: DocItemInput[] = [
    salesItem(productId, opts.qty ?? "2", opts.rate ?? "2000", opts.taxBps ?? 0),
  ];
  const totals = computeTotals(items, 0n);
  const whtAmount = opts.whtBps
    ? whtAmountPaisa(totals.items.reduce((a, i) => a + i.taxablePaisa, 0n), opts.whtBps)
    : 0n;
  const docNo = await db.transaction((tx) => nextDocNo(tx, companyId, "BILL"));
  const billId = crypto.randomUUID();
  await db.insert(s.purchaseDocs).values({
    id: billId, companyId, branchId, partyId, docType: "BILL", docNo,
    date: day, status: "POSTED", subtotal: totals.subtotal, discountTotal: 0n,
    taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    whtBps: opts.whtBps ?? undefined, whtAmount, createdById: userId,
  });
  await db.insert(s.purchaseDocItems).values(
    totals.items.map((i) => ({
      id: crypto.randomUUID(), docId: billId, productId: i.productId, description: i.description,
      qty: i.qtyMilli, rate: i.ratePaisa, discount: i.discountPaisa, taxBps: i.taxBps,
      taxAmount: i.taxAmountPaisa, lineTotal: i.lineTotalPaisa,
    }))
  );
  const entryId = await db.transaction((tx) => postPurchaseDoc(tx, {
    companyId, branchId, partyId, docId: billId, docNo, docType: "BILL",
    date: day, items: totals.items.map((i) => ({ ...i, trackStock: false })),
    discountTotal: 0n, taxTotal: totals.taxTotal, grandTotal: totals.grandTotal,
    createdById: userId,
    whtAmount: whtAmount > 0n ? whtAmount : undefined,
    whtBps: opts.whtBps,
    whtSection: opts.whtSection,
  }));
  await db.update(s.purchaseDocs).set({ journalEntryId: entryId }).where(eq(s.purchaseDocs.id, billId));
  return { billId, docNo, totals };
}

async function bankBalance(): Promise<bigint> {
  const [b] = await db.select({ balance: s.bankAccounts.balance })
    .from(s.bankAccounts).where(eq(s.bankAccounts.id, bankId)).limit(1);
  return BigInt(b.balance ?? 0);
}

/** Sum of (debit − credit) per account code for a journal entry. */
async function entrySums(entryId: string): Promise<Map<string, bigint>> {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  const out = new Map<string, bigint>();
  for (const l of lines) {
    const [a] = await db.select({ code: s.accounts.code }).from(s.accounts).where(eq(s.accounts.id, l.accountId)).limit(1);
    out.set(a.code, (out.get(a.code) ?? 0n) + (BigInt(l.debit) - BigInt(l.credit)));
  }
  return out;
}

async function paymentEntryId(paymentId: string): Promise<string> {
  const [p] = await db.select({ je: s.payments.journalEntryId })
    .from(s.payments).where(eq(s.payments.id, paymentId)).limit(1);
  return p.je!;
}

// ─── 7.1 FBR payload builder (pure) ─────────────────────────────

describe("7.1 FBR payload builder", () => {
  const items = [
    { pctCode: "8471.30.00", description: "Widget", quantity: 2, saleValuePaisa: 200000n, taxChargedPaisa: 36000n, rateBps: 1800 },
    { pctCode: null, description: "Service", quantity: 1, saleValuePaisa: 50000n, taxChargedPaisa: 0n, rateBps: 0 },
  ];

  it("sums totals and tags a New invoice with no POSID", () => {
    const p = buildFbrInvoicePayload({
      invoiceNumber: "INV-0001", posId: null, date: day, invoiceType: "New", items,
    });
    expect(p.InvoiceNumber).toBe("INV-0001");
    expect(p.InvoiceType).toBe("New");
    expect(p.POSID).toBeNull();
    expect(p.TotalSaleValue).toBe(paisaToRs(250000n));
    expect(p.TotalTaxCharged).toBe(paisaToRs(36000n));
    expect(p.TotalQuantity).toBe(3);
    expect(p.Items).toHaveLength(2);
    expect(p.Items[0].PCTCode).toBe("8471.30.00");
    expect(p.Items[1].PCTCode).toBeNull();
    expect(p.Items[0].SaleValue).toBe(paisaToRs(200000n));
    expect(p.Items[0].TaxCharged).toBe(paisaToRs(36000n));
  });

  it("tags returns as Return", () => {
    const p = buildFbrInvoicePayload({
      invoiceNumber: "INV-0001-R", posId: "POS-1", date: day, invoiceType: "Return", items,
    });
    expect(p.InvoiceType).toBe("Return");
    expect(p.POSID).toBe("POS-1");
  });

  it("builds the QR data string in the FBR format", () => {
    const d = new Date(2026, 8, 15, 12, 0, 0); // local-time safe
    expect(buildFbrQrData({ fbrInvoiceNumber: "INV-0001", ntn: "1234567", date: d, totalPaisa: 286000n }))
      .toBe(`FBR|INV-0001|NTN:1234567|DT:20260915|TOT:${paisaToRs(286000n)}`);
  });

  it("uses UNREGISTERED when the buyer has no NTN", () => {
    const d = new Date(2026, 8, 15, 12, 0, 0);
    expect(buildFbrQrData({ fbrInvoiceNumber: "INV-2", ntn: null, date: d, totalPaisa: 100000n }))
      .toContain("NTN:UNREGISTERED");
  });
});

// ─── 7.1 sync engine: honestly disabled ─────────────────────────

describe("7.1 sync engine is disabled (no live FBR integration)", () => {
  it("reports NOT_CONNECTED with a plain-language message", () => {
    const st = fbrSyncStatus();
    expect(st.connected).toBe(false);
    expect(st.status).toBe("NOT_CONNECTED");
    expect(st.message).toContain("requires FBR credentials");
  });

  it("attemptFbrSync refuses and performs no network I/O", async () => {
    const r = await attemptFbrSync();
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("DISABLED");
  });
});

// ─── 7.1 config storage is masked ───────────────────────────────

describe("7.1 FBR config (masked, write-only secret)", () => {
  it("stores the token but never returns it in full", async () => {
    await db.transaction((tx) =>
      writeFbrConfig(tx, companyId, {
        posId: "POS-77", environment: "SANDBOX", storeCode: "S1", cashierId: "C1",
        qrPlacement: "TOP", tokenSecret: "FAKE-TEST-TOKEN-1234",
      })
    );
    const view = await readFbrConfig(db, companyId);
    expect(view.posId).toBe("POS-77");
    expect(view.tokenSet).toBe(true);
    expect(view.tokenLast4).toBe("1234");
    expect(view.sync.connected).toBe(false);
    // the raw secret must not leak through the masked view
    expect(JSON.stringify(view)).not.toContain("FAKE-TEST-TOKEN-1234");
  });

  it("clears the secret when sent an empty string", async () => {
    await db.transaction((tx) =>
      writeFbrConfig(tx, companyId, {
        posId: "POS-77", environment: "SANDBOX", storeCode: "", cashierId: "",
        qrPlacement: "TOP", tokenSecret: "",
      })
    );
    const view = await readFbrConfig(db, companyId);
    expect(view.tokenSet).toBe(false);
    expect(view.tokenLast4).toBeNull();
  });

  it("readFbrPosId returns the trimmed POSID for payloads", async () => {
    const posId = await readFbrPosId(db, companyId);
    expect(posId).toBe("POS-77");
  });
});

// ─── 7.1 queue integration via postSalesDoc ──────────────────────

describe("7.1 FBR queue via postSalesDoc", () => {
  it("queues a posted invoice at DISABLED with correct totals and PCT codes", async () => {
    // no POSID configured for this invoice
    await db.transaction((tx) =>
      writeFbrConfig(tx, companyId, {
        posId: "", environment: "SANDBOX", storeCode: "", cashierId: "",
        qrPlacement: "BOTTOM", tokenSecret: "",
      })
    );
    const { docId, docNo, totals } = await postInvoice({});
    const rows = await db.select().from(s.fbrSyncQueue).where(eq(s.fbrSyncQueue.docId, docId));
    expect(rows).toHaveLength(1);
    const q = rows[0];
    expect(q.status).toBe("DISABLED"); // HARD RULE: sync engine stubbed
    expect(q.invoiceNumber).toBe(docNo);
    const payload = JSON.parse(q.payloadJson as string);
    expect(payload.InvoiceType).toBe("New");
    expect(payload.POSID).toBeNull();
    expect(payload.TotalSaleValue).toBe(paisaToRs(totals.subtotal));
    expect(payload.TotalTaxCharged).toBe(paisaToRs(totals.taxTotal));
    expect(payload.Items[0].PCTCode).toBe("8471.30.00"); // from products.pct_code
  });

  it("carries the configured POSID into queued payloads", async () => {
    await db.transaction((tx) =>
      writeFbrConfig(tx, companyId, {
        posId: "POS-99", environment: "SANDBOX", storeCode: "", cashierId: "",
        qrPlacement: "BOTTOM",
      })
    );
    expect(await readFbrPosId(db, companyId)).toBe("POS-99");
    const { docId } = await postInvoice({});
    const rows = await db.select().from(s.fbrSyncQueue).where(eq(s.fbrSyncQueue.docId, docId));
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].payloadJson as string).POSID).toBe("POS-99");
  });
});

// ─── 7.2 WHT section rates (pure) ───────────────────────────────

describe("7.2 WHT section rates", () => {
  it("returns filer/non-filer rates per section", () => {
    const filer = { activeTaxPayer: false, filerStatus: "FILER" as const };
    const nonFiler = { activeTaxPayer: false, filerStatus: "NON_FILER" as const };
    expect(whtSectionRateBps("153-SERVICES", filer)).toBe(800);
    expect(whtSectionRateBps("153-SERVICES", nonFiler)).toBe(1600);
    expect(whtSectionRateBps("153-GOODS", filer)).toBe(400);
    expect(whtSectionRateBps("153-GOODS", nonFiler)).toBe(800);
    expect(whtSectionRateBps("153-CONTRACTS", filer)).toBe(700);
    expect(whtSectionRateBps("236G", filer)).toBe(10);
    expect(whtSectionRateBps("236G", nonFiler)).toBe(20);
    expect(whtSectionRateBps("236H", filer)).toBe(50);
    expect(whtSectionRateBps("236H", nonFiler)).toBe(100);
    // ATL active-taxpayer counts as filer even without a filer status
    expect(whtSectionRateBps("153-SERVICES", { activeTaxPayer: true, filerStatus: null })).toBe(800);
  });
});

// ─── 7.2 supplier payment WHT ───────────────────────────────────

describe("7.2 supplier payment WHT", () => {
  it("posts a balanced journal, net cash, and a register row", async () => {
    const before = await bankBalance();
    const amount = parseMoney("1000");
    const { id: payId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: bankId,
        date: day, amount, method: "CASH", allocations: [], createdById: userId,
        wht: { section: "153-SERVICES", rateBps: 800 },
      })
    );
    const wht = (amount * 800n) / 10000n; // 80.00
    const net = amount - wht;

    // journal balances and matches the Module 7 pattern
    const sums = await entrySums(await paymentEntryId(payId));
    const debits = [...sums.values()].filter((v) => v > 0n).reduce((a, v) => a + v, 0n);
    const credits = [...sums.values()].filter((v) => v < 0n).reduce((a, v) => a - v, 0n);
    expect(debits).toBe(credits);
    expect(debits).toBe(amount);
    expect(sums.get(SYS.TAX_PAYABLE)).toBe(-wht); // Cr WHT payable 2100

    // cash moved net of tax
    expect(await bankBalance()).toBe(before - net);

    // payment row carries the WHT
    const [prow] = await db.select().from(s.payments).where(eq(s.payments.id, payId));
    expect(BigInt(prow.whtAmount ?? 0)).toBe(wht);
    expect(prow.whtSection).toBe("153-SERVICES");

    // register row
    const { rows } = await listWhtDeductions(db, companyId, { kind: "PAYMENT" });
    const reg = rows.find((r) => r.paymentId === payId)!;
    expect(reg).toBeDefined();
    expect(reg.taxSection).toBe("153-SERVICES");
    expect(reg.rateBps).toBe(800);
    expect(BigInt(reg.grossPaisa)).toBe(amount);
    expect(BigInt(reg.whtPaisa)).toBe(wht);
    expect(reg.deducteeName).toBe("WHT Test Supplier");
    expect(reg.ntnCnic).toBe("7654321");
  });
});

// ─── 7.2 customer receipt WHT ───────────────────────────────────

describe("7.2 customer receipt WHT", () => {
  it("posts Dr WHT 2100 as a tax credit and moves cash net", async () => {
    const before = await bankBalance();
    const amount = parseMoney("2000");
    const { id: payId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customerId, bankAccountId: bankId,
        date: day, amount, method: "CASH", allocations: [], createdById: userId,
        wht: { section: "236H", rateBps: 50 },
      })
    );
    const wht = (amount * 50n) / 10000n; // 10.00
    const sums = await entrySums(await paymentEntryId(payId));
    const debits = [...sums.values()].filter((v) => v > 0n).reduce((a, v) => a + v, 0n);
    const credits = [...sums.values()].filter((v) => v < 0n).reduce((a, v) => a - v, 0n);
    expect(debits).toBe(credits);
    expect(sums.get(SYS.TAX_PAYABLE)).toBe(wht); // Dr 2100 — tax credit
    expect(await bankBalance()).toBe(before + (amount - wht)); // cash in, net
    const { rows } = await listWhtDeductions(db, companyId, { kind: "RECEIPT" });
    const reg = rows.find((r) => r.paymentId === payId)!;
    expect(reg.taxSection).toBe("236H");
    expect(BigInt(reg.whtPaisa)).toBe(wht);
  });
});

// ─── 7.2 bill-time WHT writes the register ──────────────────────

describe("7.2 bill-time WHT register row", () => {
  it("records section, rate, gross and tax on the register", async () => {
    const { billId, totals } = await postBill({ whtBps: 800, whtSection: "153-SERVICES" });
    const gross = totals.items.reduce((a, i) => a + i.taxablePaisa, 0n);
    const wht = whtAmountPaisa(gross, 800);
    const { rows } = await listWhtDeductions(db, companyId, { kind: "BILL" });
    const reg = rows.find((r) => r.docId === billId)!;
    expect(reg).toBeDefined();
    expect(reg.taxSection).toBe("153-SERVICES");
    expect(reg.rateBps).toBe(800);
    expect(BigInt(reg.grossPaisa)).toBe(gross);
    expect(BigInt(reg.whtPaisa)).toBe(wht);
  });
});

// ─── 7.2 WHT_ALREADY_DEDUCTED guard ─────────────────────────────

describe("7.2 WHT_ALREADY_DEDUCTED", () => {
  it("rejects payment-time WHT when the bill already had WHT", async () => {
    const { billId } = await postBill({ whtBps: 800, whtSection: "153-SERVICES" });
    const err = await db
      .transaction((tx) =>
        postPayment(tx, {
          companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: bankId,
          date: day, amount: parseMoney("500"), method: "CASH",
          allocations: [{ docId: billId, docKind: "PURCHASE", amount: parseMoney("500") }],
          createdById: userId,
          wht: { section: "153-SERVICES", rateBps: 800 },
        })
      )
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).status).toBe(422);
    expect((err as UserError).code).toBe("WHT_ALREADY_DEDUCTED");
  });
});

// ─── 7.2 voids unwind WHT ───────────────────────────────────────

describe("7.2 voids unwind WHT", () => {
  it("voiding a WHT payment restores net cash and voids the register row", async () => {
    const before = await bankBalance();
    const amount = parseMoney("700");
    const { id: payId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "PAYMENT", partyId: supplierId, bankAccountId: bankId,
        date: day, amount, method: "CASH", allocations: [], createdById: userId,
        wht: { section: "153-SERVICES", rateBps: 800 },
      })
    );
    await db.transaction((tx) => voidPayment(tx, { companyId, paymentId: payId, userId }));
    // bank is whole again — the void restores the NET cash that moved
    expect(await bankBalance()).toBe(before);
    // the voiding journal balances
    const [p] = await db.select().from(s.payments).where(eq(s.payments.id, payId));
    const sums = await entrySums(p.voidJournalEntryId!);
    const debits = [...sums.values()].filter((v) => v > 0n).reduce((a, v) => a + v, 0n);
    const credits = [...sums.values()].filter((v) => v < 0n).reduce((a, v) => a - v, 0n);
    expect(debits).toBe(credits);
    // register row is voided and leaves the listing
    const { rows } = await listWhtDeductions(db, companyId, { kind: "PAYMENT" });
    expect(rows.some((r) => r.paymentId === payId)).toBe(false);
    const [raw] = await db.select().from(s.whtDeductions).where(eq(s.whtDeductions.paymentId, payId));
    expect(raw.voidedAt).not.toBeNull();
    // and no certificate is issued for it
    expect(await getWhtCertificateData(db, companyId, raw.id)).toBeNull();
  });

  it("voiding a WHT bill voids its register row", async () => {
    const { billId } = await postBill({ whtBps: 800, whtSection: "153-SERVICES" });
    await db.transaction((tx) => voidPurchaseBill(tx, { companyId, billId, userId }));
    const { rows } = await listWhtDeductions(db, companyId, { kind: "BILL" });
    expect(rows.some((r) => r.docId === billId)).toBe(false);
    const [raw] = await db.select().from(s.whtDeductions).where(eq(s.whtDeductions.docId, billId));
    expect(raw.voidedAt).not.toBeNull();
  });
});

// ─── 7.2 register list + certificate ────────────────────────────

describe("7.2 register list and certificate", () => {
  it("filters by section and totals the tax", async () => {
    const { total, totalWhtPaisa } = await listWhtDeductions(db, companyId, { section: "153-SERVICES" });
    expect(total).toBeGreaterThan(0);
    expect(totalWhtPaisa).toBeGreaterThan(0n);
    const all = await listWhtDeductions(db, companyId, {});
    expect(all.total).toBeGreaterThanOrEqual(total);
  });

  it("builds certificate data with the company as deductor", async () => {
    // the lib-level setupCompany doesn't create the companies row (signup
    // does in production) — insert it so the deductor block is realistic
    await db.insert(s.companies).values({
      id: companyId, name: "M7 Test Business", ntn: "9998888", strn: "STRN-1",
    }).onConflictDoNothing();
    const { rows } = await listWhtDeductions(db, companyId, { kind: "RECEIPT" });
    expect(rows.length).toBeGreaterThan(0);
    const cert = await getWhtCertificateData(db, companyId, rows[0].id);
    expect(cert).not.toBeNull();
    expect(cert!.deductor.name).toBe("M7 Test Business");
    expect(cert!.deductor.ntn).toBe("9998888");
    expect(cert!.deduction.deducteeName).toBe("WHT Test Customer");
    expect(cert!.deduction.taxSection).toBe("236H");
  });
});

// ─── 7.3 annexures ──────────────────────────────────────────────

describe("7.3 annexures", () => {
  it("Annexure C maps invoice tax lines with buyer NTN", async () => {
    const { docNo, totals } = await postInvoice({ taxBps: 1800 });
    const line = totals.items[0];
    const rows = await annexureCRows(db, companyId, from, to);
    const row = rows.find((r) => r.docNo === docNo)!;
    expect(row).toBeDefined();
    expect(row.buyerNtn).toBe("1234567");
    expect(row.buyerName).toBe("WHT Test Customer");
    expect(row.rateBps).toBe(1800);
    expect(row.salesValuePaisa).toBe(line.taxablePaisa);
    expect(row.taxPaisa).toBe(line.taxAmountPaisa);
  });

  it("Annexure C excludes voided invoices", async () => {
    const { docId, docNo } = await postInvoice({ taxBps: 1800 });
    await db.transaction((tx) => voidSalesInvoice(tx, { companyId, invoiceId: docId, userId }));
    const rows = await annexureCRows(db, companyId, from, to);
    expect(rows.some((r) => r.docNo === docNo)).toBe(false);
  });

  it("Annexure A maps bill tax lines with supplier NTN", async () => {
    const { docNo, totals } = await postBill({ taxBps: 1800 });
    const line = totals.items[0];
    const rows = await annexureARows(db, companyId, from, to);
    const row = rows.find((r) => r.docNo === docNo)!;
    expect(row).toBeDefined();
    expect(row.supplierNtn).toBe("7654321");
    expect(row.supplierName).toBe("WHT Test Supplier");
    expect(row.rateBps).toBe(1800);
    expect(row.purchaseValuePaisa).toBe(line.taxablePaisa);
    expect(row.taxPaisa).toBe(line.taxAmountPaisa);
  });

  it("Annexure A excludes voided bills", async () => {
    const { billId, docNo } = await postBill({ taxBps: 1800 });
    await db.transaction((tx) => voidPurchaseBill(tx, { companyId, billId, userId }));
    const rows = await annexureARows(db, companyId, from, to);
    expect(rows.some((r) => r.docNo === docNo)).toBe(false);
  });
});
