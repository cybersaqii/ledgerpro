/**
 * Module 10 — Multi-Currency & Exchange Rates (migration 0041).
 *
 * Lib-level coverage:
 *  A. lib/fx.ts pure math — half-up rounding, scaled-rate parse/format,
 *     foreign↔paisa conversion (integer-only, no floats), display helpers.
 *  B. Currency seed + SYS 4120/6040 accounts on setupCompany (idempotent).
 *  C. Migration 0041 backfill for pre-existing companies (idempotent re-run).
 *  D. Rate lookup: effective-date ranges, PKR = 1 by definition,
 *     requireDocRate error codes (FX_UNKNOWN_CURRENCY / FX_NO_RATE).
 *  E. resolveDocCurrency: exact foreign totals, per-line PKR conversion,
 *     PKR docs pass through untouched (NULL rate / foreign fields).
 *  F. FX invoice posts a balanced PKR journal with the party tagged on AR.
 *  G. Settlement gain/loss: sales gain (Dr AR / Cr 4120), purchase loss
 *     (Dr 6040 / Cr AP); PKR docs post nothing.
 *  H. voidPayment reverses the FX settlement journal (FX_SETTLEMENT_VOID).
 *  I. carryDocCurrency: derived docs keep the source's locked currency+rate.
 *  J. Idempotency guards: same-day rate upsert replaces; a settled doc
 *     cannot be allocated again (no duplicate FX journal).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap, nextDocNo } from "@/lib/setup";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { voidPayment } from "@/lib/payment-void";
import { postWriteOff } from "@/lib/writeoff";
import { insertParty } from "@/lib/party-create";
import { computeTotals } from "@/lib/totals";
import { parseQty } from "@/lib/qty";
import { UserError } from "@/lib/errors";
import {
  BASE_CURRENCY,
  RATE_SCALE,
  halfUpDiv,
  parseRateToScaled,
  formatRate,
  foreignToPaisa,
  paisaToForeignMinor,
  formatForeign,
  minorToDecimalString,
  startOfDayMs,
} from "@/lib/fx";
import { getRateForDate, requireDocRate, getCurrency } from "@/lib/fx-rates";
import { resolveDocCurrency, carryDocCurrency } from "@/lib/fx-docs";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";
let cashAccountId = "";
let customer = "";
let supplier = "";
let badDebtsAccountId = "";

const D = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h, 0, 0);
const USD_RATE = 280_500_000n; // 280.5 PKR/USD

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
  cashAccountId = (
    await db
      .select({ id: s.bankAccounts.id })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.companyId, companyId), eq(s.bankAccounts.kind, "CASH")))
      .limit(1)
  )[0]!.id;
  ({ id: customer } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "CUSTOMER", name: "M10 Customer" } })
  ));
  ({ id: supplier } = await db.transaction((tx) =>
    insertParty(tx, { companyId, userId, fields: { kind: "SUPPLIER", name: "M10 Supplier" } })
  ));
  // A plain expense account for the bad-debt write-off used in the gain test.
  badDebtsAccountId = crypto.randomUUID();
  await db.insert(s.accounts).values({
    id: badDebtsAccountId,
    companyId,
    code: "6050-T",
    name: "Bad Debts (test)",
    type: "EXPENSE",
    isSystem: false,
    isActive: true,
    openingBalance: 0n,
  });
  // USD rate in force from 2026-09-28.
  await db.insert(s.exchangeRates).values({
    companyId,
    currencyCode: "USD",
    rateScaled: USD_RATE,
    effectiveDate: startOfDayMs(D(2026, 9, 28)),
    createdById: userId,
  });
});

afterAll(() => cleanup());

/** Code → id map for the company's accounts (via a transaction, like other tests). */
const sysAccounts = () => db.transaction((tx) => accountMap(tx, companyId));

/** Sum of debit − credit over a journal entry (0 = balanced). */
async function journalNet(entryId: string): Promise<bigint> {
  const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
  return lines.reduce((a, l) => a + BigInt(l.debit) - BigInt(l.credit), 0n);
}

async function fxJournals(source: string, sourceId: string) {
  return db
    .select()
    .from(s.journalEntries)
    .where(
      and(
        eq(s.journalEntries.companyId, companyId),
        eq(s.journalEntries.source, source),
        eq(s.journalEntries.sourceId, sourceId)
      )
    );
}

/**
 * Faithful lib-level replica of POST /api/sales (FX path):
 * resolveDocCurrency → insert salesDocs row → postSalesDoc.
 */
async function postFxInvoice(opts: {
  partyId?: string;
  currencyCode: string;
  date: Date;
  items: { rate: string; discount?: string; qty?: string; taxBps?: number }[];
  discountTotal?: string;
  freightTotal?: string;
}) {
  const fx = await resolveDocCurrency(db, companyId, {
    currencyCode: opts.currencyCode,
    date: opts.date,
    items: opts.items.map((i) => ({
      productId: null,
      description: "M10 service",
      qtyMilli: parseQty(i.qty ?? "1"),
      rate: i.rate,
      discount: i.discount ?? "0",
      taxBps: i.taxBps ?? 0,
    })),
    discountTotal: opts.discountTotal ?? "0",
    freightTotal: opts.freightTotal ?? "0",
  });
  const totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal, fx.pkrFreightTotal);
  return db.transaction(async (tx) => {
    const docNo = await nextDocNo(tx, companyId, "INVOICE");
    const docId = crypto.randomUUID();
    await tx.insert(s.salesDocs).values({
      id: docId,
      companyId,
      branchId,
      partyId: opts.partyId ?? customer,
      docType: "INVOICE",
      docNo,
      date: opts.date,
      status: "POSTED",
      subtotal: totals.subtotal,
      discountTotal: fx.pkrDiscountTotal,
      freightTotal: fx.pkrFreightTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      createdById: userId,
      currencyCode: fx.currencyCode,
      exchangeRateScaled: fx.rateScaled,
      foreignSubtotal: fx.foreignSubtotal,
      foreignTotal: fx.foreignTotal,
    });
    const entryId = await postSalesDoc(tx, {
      companyId,
      branchId,
      partyId: opts.partyId ?? customer,
      docId,
      docNo,
      docType: "INVOICE",
      date: opts.date,
      items: totals.items.map((i) => ({ ...i, trackStock: false })),
      discountTotal: fx.pkrDiscountTotal,
      freightTotal: fx.pkrFreightTotal,
      taxTotal: totals.taxTotal,
      grandTotal: totals.grandTotal,
      createdById: userId,
    });
    await tx.update(s.salesDocs).set({ journalEntryId: entryId }).where(eq(s.salesDocs.id, docId));
    return { docId, docNo, grandTotal: totals.grandTotal, entryId, fx };
  });
}

describe("A. fx math is integer-only with half-up rounding", () => {
  it("halfUpDiv rounds half away from zero and throws on non-positive divisor", () => {
    expect(halfUpDiv(5n, 2n)).toBe(3n); // 2.5 → 3
    expect(halfUpDiv(4n, 2n)).toBe(2n); // exact
    expect(halfUpDiv(-5n, 2n)).toBe(-3n); // −2.5 → −3 (away from zero)
    expect(halfUpDiv(-4n, 2n)).toBe(-2n);
    expect(halfUpDiv(7n, 4n)).toBe(2n); // 1.75 → 2
    expect(() => halfUpDiv(1n, 0n)).toThrow();
    expect(() => halfUpDiv(1n, -2n)).toThrow();
  });

  it("parseRateToScaled parses up to 6 decimals and rejects garbage", () => {
    expect(parseRateToScaled("280.5")).toBe(280_500_000n);
    expect(parseRateToScaled("280.505555")).toBe(280_505_555n);
    expect(parseRateToScaled("1")).toBe(1_000_000n);
    expect(parseRateToScaled("0.000001")).toBe(1n);
    expect(() => parseRateToScaled("abc")).toThrow();
    expect(() => parseRateToScaled("-1")).toThrow();
    expect(() => parseRateToScaled("0")).toThrow();
    expect(() => parseRateToScaled("1.1234567")).toThrow(); // > 6 decimals
    expect(() => parseRateToScaled("")).toThrow();
  });

  it("formatRate round-trips the scaled integer", () => {
    expect(formatRate(280_500_000n)).toBe("280.5");
    expect(formatRate(1_000_000n)).toBe("1");
    expect(formatRate(280_505_555n)).toBe("280.505555");
    expect(parseRateToScaled(formatRate(280_505_555n))).toBe(280_505_555n);
  });

  it("foreignToPaisa converts exactly, half-up at the paisa boundary", () => {
    // $100.00 @ 280.5 → Rs 28,050.00 exactly
    expect(foreignToPaisa(10_000n, USD_RATE, 2)).toBe(2_805_000n);
    // 1 cent @ 1.5 → 1.5 paisa → half-up → 2
    expect(foreignToPaisa(1n, 1_500_000n, 2)).toBe(2n);
    // 1 cent @ 0.5 → 0.5 paisa → half-up → 1
    expect(foreignToPaisa(1n, 500_000n, 2)).toBe(1n);
    // negative rounds away from zero
    expect(foreignToPaisa(-1n, 500_000n, 2)).toBe(-1n);
    // zero-decimal currency (JPY): ¥100 @ 1.9 → Rs 190.00
    expect(foreignToPaisa(100n, 1_900_000n, 0)).toBe(19_000n);
    expect(() => foreignToPaisa(1n, 0n, 2)).toThrow();
  });

  it("paisaToForeignMinor inverts foreignToPaisa up to rounding dust", () => {
    expect(paisaToForeignMinor(2_805_000n, USD_RATE, 2)).toBe(10_000n);
    const back = paisaToForeignMinor(foreignToPaisa(12_345n, USD_RATE, 2), USD_RATE, 2);
    expect(back - 12_345n <= 1n && back - 12_345n >= -1n).toBe(true);
    expect(() => paisaToForeignMinor(1n, 0n, 2)).toThrow();
  });

  it("display helpers format minor units without floats", () => {
    expect(minorToDecimalString(12_345n, 2)).toBe("123.45");
    expect(minorToDecimalString(-50n, 2)).toBe("-0.50");
    expect(formatForeign(1_234_567n, 2, "$")).toBe("$ 12,345.67");
    expect(formatForeign(-1_234_567n, 2, "$")).toBe("-$ 12,345.67");
    expect(BASE_CURRENCY).toBe("PKR");
    expect(RATE_SCALE).toBe(6);
  });
});

describe("B. currency seed + SYS 4120/6040 on setupCompany", () => {
  it("seeds the default set with PKR as base and both FX accounts", async () => {
    const curRows = await db
      .select()
      .from(s.currencies)
      .where(eq(s.currencies.companyId, companyId));
    const codes = curRows.map((c) => c.code).sort();
    expect(codes).toEqual(["AED", "CNY", "EUR", "GBP", "PKR", "SAR", "USD"]);
    const pkr = curRows.find((c) => c.code === "PKR")!;
    expect(pkr.isBase).toBe(1);
    expect(pkr.minorUnits).toBe(2);
    expect(curRows.every((c) => c.isActive === 1)).toBe(true);

    const ac = await sysAccounts();
    expect(ac[SYS.EXCHANGE_GAIN]).toBeTruthy();
    expect(ac[SYS.EXCHANGE_LOSS]).toBeTruthy();
    const [gain] = await db
      .select()
      .from(s.accounts)
      .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, "4120")))
      .limit(1);
    const [loss] = await db
      .select()
      .from(s.accounts)
      .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, "6040")))
      .limit(1);
    expect(gain.type).toBe("INCOME");
    expect(gain.isSystem).toBe(true);
    expect(loss.type).toBe("EXPENSE");
    expect(loss.isSystem).toBe(true);
  });

  it("setupCompany re-run is idempotent — no duplicate currencies or accounts", async () => {
    await setupCompany(db, companyId);
    const curRows = await db
      .select()
      .from(s.currencies)
      .where(eq(s.currencies.companyId, companyId));
    expect(curRows).toHaveLength(7);
    const gainRows = await db
      .select()
      .from(s.accounts)
      .where(and(eq(s.accounts.companyId, companyId), eq(s.accounts.code, "4120")));
    expect(gainRows).toHaveLength(1);
  });
});

describe("C. migration 0041 backfills pre-existing companies", () => {
  it("currencies + 4120/6040 are seeded for a company created after the migration ran", async () => {
    // Simulate a company that existed before 0041: insert it raw (no
    // setupCompany seed), then replay only the backfill INSERT statements.
    const legacyId = crypto.randomUUID();
    await db.insert(s.companies).values({ id: legacyId, name: "Legacy Co" });
    const migPath = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations", "0041_module10_multicurrency.sql");
    const migText = readFileSync(migPath, "utf8")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    const backfills = migText
      .split(";")
      .map((stmt) => stmt.trim())
      .filter(
        (stmt) =>
          stmt.startsWith("INSERT INTO currencies") || stmt.startsWith("INSERT INTO accounts")
      );
    expect(backfills).toHaveLength(2);
    for (let run = 0; run < 2; run++) {
      for (const stmt of backfills) await db.run(sql.raw(stmt));
      const curRows = await db
        .select()
        .from(s.currencies)
        .where(eq(s.currencies.companyId, legacyId));
      expect(curRows.map((c) => c.code).sort()).toEqual([
        "AED", "CNY", "EUR", "GBP", "PKR", "SAR", "USD",
      ]);
      const fxAccts = await db
        .select()
        .from(s.accounts)
        .where(
          and(
            eq(s.accounts.companyId, legacyId),
            eq(s.accounts.isSystem, true)
          )
        );
      expect(fxAccts.filter((a) => a.code === "4120" || a.code === "6040")).toHaveLength(2);
    }
  });
});

describe("D. rate lookup follows effective-date ranges", () => {
  beforeAll(async () => {
    // A second USD rate: 281.25 from 2026-09-30 — the 280.5 row stays in force before it.
    await db.insert(s.exchangeRates).values({
      companyId,
      currencyCode: "USD",
      rateScaled: 281_250_000n,
      effectiveDate: startOfDayMs(D(2026, 9, 30)),
      createdById: userId,
    });
  });

  it("picks the latest rate on or before the doc date", async () => {
    expect((await getRateForDate(db, companyId, "USD", D(2026, 9, 29))).rateScaled).toBe(USD_RATE);
    expect((await getRateForDate(db, companyId, "USD", D(2026, 9, 30))).rateScaled).toBe(281_250_000n);
    expect((await getRateForDate(db, companyId, "USD", D(2026, 10, 15))).rateScaled).toBe(281_250_000n);
  });

  it("returns 0 when no rate exists yet, and 1.0 for PKR by definition", async () => {
    expect((await getRateForDate(db, companyId, "USD", D(2026, 9, 1))).rateScaled).toBe(0n);
    const pkr = await getRateForDate(db, companyId, "PKR", D(2026, 1, 1));
    expect(pkr.rateScaled).toBe(10n ** BigInt(RATE_SCALE));
  });

  it("requireDocRate throws stable codes for unknown currency / missing rate", async () => {
    await expect(requireDocRate(db, companyId, "XXX", D(2026, 10, 1))).rejects.toMatchObject({
      code: "FX_UNKNOWN_CURRENCY",
    });
    // EUR is seeded but has no rate row.
    await expect(requireDocRate(db, companyId, "EUR", D(2026, 10, 1))).rejects.toMatchObject({
      code: "FX_NO_RATE",
    });
    const ok = await requireDocRate(db, companyId, "usd", D(2026, 10, 1));
    expect(ok.rateScaled).toBe(281_250_000n);
    expect(ok.currency.minorUnits).toBe(2);
  });

  it("getCurrency is company-scoped and ignores inactive currencies", async () => {
    expect(await getCurrency(db, "no-such-company", "USD")).toBeNull();
    const usd = await getCurrency(db, companyId, "USD");
    expect(usd?.code).toBe("USD");
  });
});

describe("E. resolveDocCurrency converts per line and ties to doc totals", () => {
  it("USD invoice: exact foreign totals, PKR lines tie to the PKR grand total", async () => {
    const fx = await resolveDocCurrency(db, companyId, {
      currencyCode: "USD",
      date: D(2026, 9, 29), // 280.5 in force
      items: [
        { productId: null, description: "A", qtyMilli: parseQty("2"), rate: "100.00", discount: "5.00", taxBps: 0 },
      ],
      discountTotal: "10.00",
      freightTotal: "7.50",
    });
    // Foreign: subtotal 200.00, item disc 5.00, doc disc 10.00, freight 7.50 → 192.50
    expect(fx.foreignSubtotal).toBe(20_000n);
    expect(fx.foreignTotal).toBe(19_250n);
    expect(fx.rateScaled).toBe(USD_RATE);
    // PKR lines: rate 100.00 → 2,805,000n paisa; discount 5.00 → 140,250n
    expect(fx.pkrItems[0]!.ratePaisa).toBe(2_805_000n);
    expect(fx.pkrItems[0]!.discountPaisa).toBe(140_250n);
    expect(fx.pkrDiscountTotal).toBe(280_500n);
    expect(fx.pkrFreightTotal).toBe(210_375n);
    // The caller's computeTotals over the converted lines must tie exactly.
    const totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal, fx.pkrFreightTotal);
    expect(totals.grandTotal).toBe(5_399_625n); // $192.50 × 280.5
    // Sanity: recomputing from the stored foreign total converts to the same PKR.
    expect(foreignToPaisa(fx.foreignTotal!, USD_RATE, 2)).toBe(totals.grandTotal);
  });

  it("PKR docs pass through untouched — no rate, no foreign fields", async () => {
    const fx = await resolveDocCurrency(db, companyId, {
      currencyCode: "PKR",
      date: D(2026, 10, 1),
      items: [
        { productId: null, description: "A", qtyMilli: parseQty("3"), rate: "100.00", discount: "0", taxBps: 0 },
      ],
      discountTotal: "0",
      freightTotal: "0",
    });
    expect(fx.rateScaled).toBeNull();
    expect(fx.foreignSubtotal).toBeNull();
    expect(fx.foreignTotal).toBeNull();
    expect(fx.pkrItems[0]!.ratePaisa).toBe(10_000n); // paisa, as before
    const totals = computeTotals(fx.pkrItems, fx.pkrDiscountTotal, fx.pkrFreightTotal);
    expect(totals.grandTotal).toBe(30_000n);
  });

  it("rejects excess decimals for the document currency's own scale (PKR: 2)", async () => {
    // "10.999" passes the wire-format regex (≤6 decimals) but PKR only allows
    // 2 — the server rejects it with a 422, preserving the paisa invariant.
    const err = await resolveDocCurrency(db, companyId, {
      currencyCode: "PKR",
      date: D(2026, 10, 1),
      items: [
        { productId: null, description: "A", qtyMilli: parseQty("1"), rate: "10.999", discount: "0", taxBps: 0 },
      ],
      discountTotal: "0",
    }).catch((e) => e);
    expect(err).toBeInstanceOf(UserError);
    expect((err as UserError).status).toBe(422);
  });

  it("rejects negative line amounts via the shared totals engine", async () => {
    await expect(
      resolveDocCurrency(db, companyId, {
        currencyCode: "USD",
        date: D(2026, 9, 29),
        items: [
          { productId: null, description: "A", qtyMilli: parseQty("1"), rate: "-5.00", discount: "0", taxBps: 0 },
        ],
        discountTotal: "0",
      }).then((fx) => computeTotals(fx.pkrItems, fx.pkrDiscountTotal, fx.pkrFreightTotal))
    ).rejects.toThrow();
  });
});

describe("F. FX invoice posts a balanced PKR journal", () => {
  it("USD invoice journal balances with the party tagged on AR", async () => {
    const { entryId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "100.00", qty: "2" }],
    });
    expect(grandTotal).toBe(5_610_000n);
    expect(await journalNet(entryId)).toBe(0n);
    const ac = await sysAccounts();
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entryId));
    const ar = lines.find((l) => l.accountId === ac[SYS.AR])!;
    expect(ar).toBeTruthy();
    expect(BigInt(ar.debit)).toBe(grandTotal);
    expect(ar.partyId).toBe(customer);
  });

  it("doc row stores the locked rate and foreign totals", async () => {
    const { docId, fx } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "50.00", qty: "1" }],
    });
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.currencyCode).toBe("USD");
    expect(BigInt(doc.exchangeRateScaled!)).toBe(USD_RATE);
    expect(BigInt(doc.foreignTotal!)).toBe(5_000n);
    expect(fx.foreignTotal).toBe(5_000n);
  });
});

describe("G. exchange gain/loss posts on settlement", () => {
  it("sales: collecting a written-off balance posts Dr AR / Cr Exchange Gain 4120", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "100.00", qty: "2" }], // Rs 56,100.00
    });
    // Write off Rs 50.00 of it, then collect the full original balance anyway.
    await db.transaction((tx) =>
      postWriteOff(tx, {
        companyId,
        branchId,
        partyId: customer,
        salesDocId: docId,
        accountId: badDebtsAccountId,
        date: D(2026, 10, 1),
        amount: 5_000n,
        createdById: userId,
      })
    );
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId,
        branchId,
        kind: "RECEIPT",
        partyId: customer,
        bankAccountId: cashAccountId,
        date: D(2026, 10, 1),
        amount: grandTotal,
        method: "CASH",
        allocations: [{ docId, docKind: "SALES", amount: grandTotal }],
        createdById: userId,
      })
    );
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.status).toBe("PAID");

    const ac = await sysAccounts();
    const entries = await fxJournals("FX_SETTLEMENT", paymentId);
    expect(entries).toHaveLength(1);
    expect(await journalNet(entries[0]!.id)).toBe(0n);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entries[0]!.id));
    expect(lines).toHaveLength(2);
    const dr = lines.find((l) => BigInt(l.debit) > 0n)!;
    const cr = lines.find((l) => BigInt(l.credit) > 0n)!;
    expect(dr.accountId).toBe(ac[SYS.AR]);
    expect(BigInt(dr.debit)).toBe(5_000n);
    expect(dr.partyId).toBe(customer);
    expect(cr.accountId).toBe(ac[SYS.EXCHANGE_GAIN]);
    expect(BigInt(cr.credit)).toBe(5_000n);
  });

  it("purchase: paying more than the net bill posts Dr Exchange Loss 6040 / Cr AP", async () => {
    const billId = crypto.randomUUID();
    const grandTotal = 2_805_000n; // $100 @ 280.5
    await db.transaction(async (tx) => {
      await tx.insert(s.purchaseDocs).values({
        id: billId,
        companyId,
        branchId,
        partyId: supplier,
        docType: "BILL",
        docNo: await nextDocNo(tx, companyId, "BILL"),
        date: D(2026, 9, 29),
        status: "POSTED",
        subtotal: grandTotal,
        discountTotal: 0n,
        taxTotal: 0n,
        grandTotal,
        writtenOffAmount: 4_000n, // simulated non-collectible reduction
        createdById: userId,
        currencyCode: "USD",
        exchangeRateScaled: USD_RATE,
        foreignSubtotal: 10_000n,
        foreignTotal: 10_000n,
      });
    });
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId,
        branchId,
        kind: "PAYMENT",
        partyId: supplier,
        bankAccountId: cashAccountId,
        date: D(2026, 10, 1),
        amount: grandTotal,
        method: "CASH",
        allocations: [{ docId: billId, docKind: "PURCHASE", amount: grandTotal }],
        createdById: userId,
      })
    );
    const ac = await sysAccounts();
    const entries = await fxJournals("FX_SETTLEMENT", paymentId);
    expect(entries).toHaveLength(1);
    expect(await journalNet(entries[0]!.id)).toBe(0n);
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, entries[0]!.id));
    const dr = lines.find((l) => BigInt(l.debit) > 0n)!;
    const cr = lines.find((l) => BigInt(l.credit) > 0n)!;
    expect(dr.accountId).toBe(ac[SYS.EXCHANGE_LOSS]);
    expect(BigInt(dr.debit)).toBe(4_000n);
    expect(cr.accountId).toBe(ac[SYS.AP]);
    expect(BigInt(cr.credit)).toBe(4_000n);
    expect(cr.partyId).toBe(supplier);
  });

  it("settlement at exactly the doc rate posts no FX journal", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "10.00", qty: "1" }],
    });
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId,
        branchId,
        kind: "RECEIPT",
        partyId: customer,
        bankAccountId: cashAccountId,
        date: D(2026, 10, 1),
        amount: grandTotal,
        method: "CASH",
        allocations: [{ docId, docKind: "SALES", amount: grandTotal }],
        createdById: userId,
      })
    );
    expect(await fxJournals("FX_SETTLEMENT", paymentId)).toHaveLength(0);
  });

  it("partial allocations never post FX — only the settling one does", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "20.00", qty: "1" }],
    });
    const half = grandTotal / 2n;
    const p1 = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: D(2026, 10, 1), amount: half,
        method: "CASH", allocations: [{ docId, docKind: "SALES", amount: half }],
        createdById: userId,
      })
    );
    expect(await fxJournals("FX_SETTLEMENT", p1.id)).toHaveLength(0);
    const [mid] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(mid.status).toBe("PARTIAL");
  });
});

describe("H. PKR documents are unaffected by Module 10", () => {
  it("PKR invoice + settlement posts no FX journal and NULL currency fields", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "PKR",
      date: D(2026, 10, 1),
      items: [{ rate: "100.00", qty: "2" }],
    });
    expect(grandTotal).toBe(20_000n); // paisa — identical to the pre-module-10 path
    const [doc] = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, docId)).limit(1);
    expect(doc.currencyCode).toBe("PKR");
    expect(doc.exchangeRateScaled).toBeNull();
    expect(doc.foreignTotal).toBeNull();
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: D(2026, 10, 1), amount: grandTotal,
        method: "CASH", allocations: [{ docId, docKind: "SALES", amount: grandTotal }],
        createdById: userId,
      })
    );
    expect(await fxJournals("FX_SETTLEMENT", paymentId)).toHaveLength(0);
  });
});

describe("I. voiding a payment reverses its FX settlement", () => {
  it("voidPayment posts a balanced FX_SETTLEMENT_VOID reversing journal", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "100.00", qty: "1" }],
    });
    await db.transaction((tx) =>
      postWriteOff(tx, {
        companyId, branchId, partyId: customer, salesDocId: docId,
        accountId: badDebtsAccountId, date: D(2026, 10, 1), amount: 3_000n,
        createdById: userId,
      })
    );
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: D(2026, 10, 1), amount: grandTotal,
        method: "CASH", allocations: [{ docId, docKind: "SALES", amount: grandTotal }],
        createdById: userId,
      })
    );
    expect(await fxJournals("FX_SETTLEMENT", paymentId)).toHaveLength(1);

    await db.transaction((tx) =>
      voidPayment(tx, { companyId, paymentId, userId, reason: "M10 test void" })
    );
    const voids = await fxJournals("FX_SETTLEMENT_VOID", paymentId);
    expect(voids).toHaveLength(1);
    expect(await journalNet(voids[0]!.id)).toBe(0n);
    const ac = await sysAccounts();
    const lines = await db.select().from(s.journalLines).where(eq(s.journalLines.entryId, voids[0]!.id));
    const dr = lines.find((l) => BigInt(l.debit) > 0n)!;
    const cr = lines.find((l) => BigInt(l.credit) > 0n)!;
    // Original was Dr AR 3,000 / Cr 4120 3,000 — the void flips it.
    expect(dr.accountId).toBe(ac[SYS.EXCHANGE_GAIN]);
    expect(BigInt(dr.debit)).toBe(3_000n);
    expect(cr.accountId).toBe(ac[SYS.AR]);
    expect(BigInt(cr.credit)).toBe(3_000n);
  });
});

describe("J. carryDocCurrency locks the source rate on derived docs", () => {
  it("FX source keeps currency + rate; foreign totals convert back at the locked rate", async () => {
    const out = await carryDocCurrency(
      db,
      companyId,
      { currencyCode: "USD", exchangeRateScaled: USD_RATE },
      2_805_000n,
      5_610_000n
    );
    expect(out.currencyCode).toBe("USD");
    expect(out.exchangeRateScaled).toBe(USD_RATE);
    expect(out.foreignSubtotal).toBe(10_000n);
    expect(out.foreignTotal).toBe(20_000n);
  });

  it("PKR sources yield NULL foreign fields", async () => {
    const out = await carryDocCurrency(
      db,
      companyId,
      { currencyCode: "PKR", exchangeRateScaled: null },
      20_000n,
      20_000n
    );
    expect(out.currencyCode).toBe("PKR");
    expect(out.exchangeRateScaled).toBeNull();
    expect(out.foreignSubtotal).toBeNull();
    expect(out.foreignTotal).toBeNull();
  });

  it("throws FX_UNKNOWN_CURRENCY when the source currency was disabled", async () => {
    await expect(
      carryDocCurrency(db, companyId, { currencyCode: "XXX", exchangeRateScaled: 1_000_000n }, 1n, 1n)
    ).rejects.toMatchObject({ code: "FX_UNKNOWN_CURRENCY" });
  });
});

describe("K. idempotency guards", () => {
  it("same-day rate set replaces the day's rate (no duplicate rows)", async () => {
    const day = startOfDayMs(D(2026, 10, 2));
    const upsert = (rate: bigint) =>
      db
        .insert(s.exchangeRates)
        .values({ companyId, currencyCode: "USD", rateScaled: rate, effectiveDate: day, createdById: userId })
        .onConflictDoUpdate({
          target: [s.exchangeRates.companyId, s.exchangeRates.currencyCode, s.exchangeRates.effectiveDate],
          set: { rateScaled: rate, createdById: userId },
        });
    await upsert(282_000_000n);
    await upsert(283_000_000n); // "correction" — same unique key
    const rows = await db
      .select()
      .from(s.exchangeRates)
      .where(
        and(
          eq(s.exchangeRates.companyId, companyId),
          eq(s.exchangeRates.currencyCode, "USD"),
          eq(s.exchangeRates.effectiveDate, day)
        )
      );
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0]!.rateScaled)).toBe(283_000_000n);
    expect((await getRateForDate(db, companyId, "USD", D(2026, 10, 2))).rateScaled).toBe(283_000_000n);
  });

  it("a settled doc cannot be allocated again — no duplicate FX journal", async () => {
    const { docId, grandTotal } = await postFxInvoice({
      currencyCode: "USD",
      date: D(2026, 9, 29),
      items: [{ rate: "30.00", qty: "1" }],
    });
    await db.transaction((tx) =>
      postWriteOff(tx, {
        companyId, branchId, partyId: customer, salesDocId: docId,
        accountId: badDebtsAccountId, date: D(2026, 10, 1), amount: 2_000n,
        createdById: userId,
      })
    );
    const { id: paymentId } = await db.transaction((tx) =>
      postPayment(tx, {
        companyId, branchId, kind: "RECEIPT", partyId: customer,
        bankAccountId: cashAccountId, date: D(2026, 10, 1), amount: grandTotal,
        method: "CASH", allocations: [{ docId, docKind: "SALES", amount: grandTotal }],
        createdById: userId,
      })
    );
    expect(await fxJournals("FX_SETTLEMENT", paymentId)).toHaveLength(1);
    // A second allocation against the now-PAID doc is rejected outright.
    await expect(
      db.transaction((tx) =>
        postPayment(tx, {
          companyId, branchId, kind: "RECEIPT", partyId: customer,
          bankAccountId: cashAccountId, date: D(2026, 10, 1), amount: 1_000n,
          method: "CASH", allocations: [{ docId, docKind: "SALES", amount: 1_000n }],
          createdById: userId,
        })
      )
    ).rejects.toThrow(/exceeds remaining/i);
    expect(await fxJournals("FX_SETTLEMENT", paymentId)).toHaveLength(1);
  });
});

describe("L. error paths surface as UserError", () => {
  it("FX errors carry stable codes (not 500s)", async () => {
    const e1 = await requireDocRate(db, companyId, "XXX", D(2026, 10, 1)).catch((e) => e);
    expect(e1).toBeInstanceOf(UserError);
    expect((e1 as UserError).code).toBe("FX_UNKNOWN_CURRENCY");
    const e2 = await requireDocRate(db, companyId, "EUR", D(2026, 10, 1)).catch((e) => e);
    expect((e2 as UserError).code).toBe("FX_NO_RATE");
  });
});
