/**
 * Module 20 — CSV/Excel importers (products, parties, opening stock).
 *
 * Covers: parseCSV (quoted commas, CRLF, BOM), autoMapFields header aliases,
 * parseKind, validateImport (field rules with CSV row numbers, in-file
 * duplicates as errors, DB duplicates as skips — never errors), commitImport
 * all-or-nothing, and opening-stock posting a balanced Dr Inventory /
 * Cr Opening Equity journal per product.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and, inArray } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, accountMap, SYS } from "@/lib/setup";
import {
  parseCSV,
  autoMapFields,
  validateImport,
  commitImport,
  parseKind,
  fieldsFor,
} from "@/lib/importer";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const userId = crypto.randomUUID();
let branchId = "";

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "Import Test Co" });
  const res = await setupCompany(db, companyId);
  branchId = res.branchId;
});

afterAll(() => cleanup());

describe("parseCSV", () => {
  it("handles CRLF, quoted commas, and a BOM", () => {
    const rows = parseCSV('﻿sku,name,note\r\n"AB-1","Widget, large","say ""hi"""\r\nAB-2,Plain,ok\r\n');
    expect(rows).toEqual([
      ["sku", "name", "note"],
      ["AB-1", "Widget, large", 'say "hi"'],
      ["AB-2", "Plain", "ok"],
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseCSV("")).toEqual([]);
  });
});

describe("autoMapFields", () => {
  it("guesses columns from header aliases", () => {
    const map = autoMapFields(["SKU", "Item Name", "Sale Price", "Purchase Price", "random"], fieldsFor("products"));
    expect(map.sku).toBe(0);
    expect(map.name).toBe(1);
    expect(map.salePrice).toBe(2);
    expect(map.purchasePrice).toBe(3);
    expect(map.barcode).toBeNull();
  });

  it("maps party phone/address and opening-stock qty columns", () => {
    const pm = autoMapFields(["Customer", "Mobile", "City"], fieldsFor("parties"));
    expect(pm.name).toBe(0);
    expect(pm.phone).toBe(1);
    expect(pm.city).toBe(2);
    const om = autoMapFields(["SKU", "Quantity", "Unit Cost"], fieldsFor("opening_stock"));
    expect(om.sku).toBe(0);
    expect(om.qty).toBe(1);
    expect(om.rate).toBe(2); // engine field is "rate" ("Unit Cost" is an alias)
  });
});

describe("parseKind", () => {
  it("accepts the three kinds and rejects anything else", () => {
    expect(parseKind("products")).toBe("products");
    expect(parseKind("parties")).toBe("parties");
    expect(parseKind("opening_stock")).toBe("opening_stock");
    expect(() => parseKind("xls")).toThrow();
    expect(() => parseKind(undefined)).toThrow();
  });
});

describe("validateImport — products", () => {
  it("flags field errors with CSV row numbers and in-file duplicates", async () => {
    const rows = parseCSV("sku,name,sale_price\nA1,Widget,250\nA2,,100\nA1,Widget Dup,300\nA3,Gadget,abc\n");
    const map = autoMapFields(rows[0]!, fieldsFor("products"));
    const r = await validateImport(db, companyId, "products", rows, map);
    expect(r.totalRows).toBe(4);
    expect(r.errorCount).toBe(3);
    const byRow = new Map(r.errors.map((e) => [e.row, e.message]));
    expect(byRow.get(3)).toMatch(/name/i); // row 3: missing name
    expect(byRow.get(4)).toMatch(/duplicate/i); // row 4: dup SKU A1
    expect(byRow.get(5)).toMatch(/price/i); // row 5: bad price
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ sku: "A1", name: "Widget", salePrice: 25000n });
  });

  it("treats existing SKUs as skipped, not errors", async () => {
    const pid = crypto.randomUUID();
    await db.insert(s.products).values({
      id: pid, companyId, sku: "EXIST-1", name: "Existing Widget", unit: "PCS",
      purchasePrice: 10000n, salePrice: 15000n, trackStock: true,
    });
    const rows = parseCSV("sku,name,sale_price\nEXIST-1,Existing Widget,150\nNEW-9,Fresh Item,99\n");
    const map = autoMapFields(rows[0]!, fieldsFor("products"));
    const r = await validateImport(db, companyId, "products", rows, map);
    expect(r.errorCount).toBe(0);
    expect(r.skipped).toBe(1);
    expect(r.valid).toHaveLength(1);
    expect(r.valid[0]).toMatchObject({ sku: "NEW-9" });
  });

  it("rejects when a required field is not mapped", async () => {
    const rows = parseCSV("code,title\nX1,Nope\n"); // "code" is a SKU alias — "Name" stays unmapped
    const map = autoMapFields(rows[0]!, fieldsFor("products"));
    const r = await validateImport(db, companyId, "products", rows, map);
    expect(r.errorCount).toBe(1);
    expect(r.errors[0]!.message).toMatch(/name/i);
  });
});

describe("commitImport — products & parties", () => {
  it("inserts every validated product row", async () => {
    const rows = parseCSV("sku,name,sale_price\nC1,Commit A,10\nC2,Commit B,20\n");
    const map = autoMapFields(rows[0]!, fieldsFor("products"));
    const r = await validateImport(db, companyId, "products", rows, map);
    expect(r.errorCount).toBe(0);
    const res = await db.transaction((tx) => commitImport(tx, companyId, userId, "products", r.valid));
    expect(res.imported).toBe(2);
    const got = await db.select().from(s.products).where(
      and(eq(s.products.companyId, companyId), inArray(s.products.sku, ["C1", "C2"]))
    );
    expect(got).toHaveLength(2);
  });

  it("skips existing name+phone parties and inserts the rest", async () => {
    const pid = crypto.randomUUID();
    await db.insert(s.parties).values({
      id: pid, companyId, kind: "CUSTOMER", name: "Dup Party", phone: "03001234567", balance: 0n,
    });
    const rows = parseCSV("kind,name,phone\nCUSTOMER,Dup Party,0300 1234567\nSUPPLIER,New Supplier,03009998888\n");
    const map = autoMapFields(rows[0]!, fieldsFor("parties"));
    const r = await validateImport(db, companyId, "parties", rows, map);
    expect(r.errorCount).toBe(0);
    expect(r.skipped).toBe(1); // phone normalization matches "0300 1234567"
    const res = await db.transaction((tx) => commitImport(tx, companyId, userId, "parties", r.valid));
    expect(res.imported).toBe(1);
    const got = await db.select().from(s.parties).where(
      and(eq(s.parties.companyId, companyId), eq(s.parties.name, "New Supplier"))
    );
    expect(got).toHaveLength(1);
  });

  it("flags an in-file duplicate party name+phone as an error", async () => {
    const rows = parseCSV("kind,name,phone\nCUSTOMER,Twin,03001112222\nCUSTOMER,Twin,03001112222\n");
    const map = autoMapFields(rows[0]!, fieldsFor("parties"));
    const r = await validateImport(db, companyId, "parties", rows, map);
    expect(r.errorCount).toBe(1);
    expect(r.errors[0]!.message).toMatch(/duplicate/i);
  });
});

describe("commitImport — opening stock", () => {
  const sku = "OPN-1";
  let productId = "";

  beforeAll(async () => {
    productId = crypto.randomUUID();
    await db.insert(s.products).values({
      id: productId, companyId, sku, name: "Opening Item", unit: "PCS",
      purchasePrice: 8000n, salePrice: 10000n, trackStock: true, itemType: "INVENTORY",
    });
  });

  it("posts a balanced Dr Inventory / Cr Opening Equity journal and seeds stock", async () => {
    const rows = parseCSV("sku,qty,rate\nOPN-1,10,80\n");
    const map = autoMapFields(rows[0]!, fieldsFor("opening_stock"));
    const r = await validateImport(db, companyId, "opening_stock", rows, map);
    expect(r.errorCount).toBe(0);
    expect(r.valid).toHaveLength(1);
    const res = await db.transaction((tx) => commitImport(tx, companyId, userId, "opening_stock", r.valid));
    expect(res.imported).toBe(1);

    // Stock seeded: 10 units in milli = 10000.
    const [lvl] = await db.select().from(s.stockLevels).where(
      and(eq(s.stockLevels.productId, productId), eq(s.stockLevels.branchId, branchId))
    );
    expect(lvl).toBeDefined();
    expect(BigInt(lvl!.qty)).toBe(10000n);

    // Journal: Dr inventory, Cr opening equity, balanced.
    const ac = await accountMap(db, companyId);
    const entries = await db.select().from(s.journalEntries).where(
      and(eq(s.journalEntries.companyId, companyId), eq(s.journalEntries.source, "OPENING_STOCK"))
    );
    expect(entries.length).toBeGreaterThan(0);
    const entryIds = entries.map((e) => e.id);
    const lines = await db.select().from(s.journalLines).where(inArray(s.journalLines.entryId, entryIds));
    const dr = lines.reduce((a, l) => a + BigInt(l.debit), 0n);
    const cr = lines.reduce((a, l) => a + BigInt(l.credit), 0n);
    expect(dr).toBe(cr);
    expect(dr).toBe(80000n); // 10 × Rs 80
    const invLine = lines.find((l) => l.accountId === ac[SYS.INVENTORY]);
    const eqLine = lines.find((l) => l.accountId === ac[SYS.OPENING_EQUITY]);
    expect(invLine && BigInt(invLine.debit)).toBe(80000n);
    expect(eqLine && BigInt(eqLine.credit)).toBe(80000n);
  });

  it("refuses opening stock twice for the same product and for unknown SKUs", async () => {
    const rows = parseCSV("sku,qty,rate\nOPN-1,5,80\nNOPE-9,5,80\n");
    const map = autoMapFields(rows[0]!, fieldsFor("opening_stock"));
    const r = await validateImport(db, companyId, "opening_stock", rows, map);
    expect(r.errorCount).toBe(2);
    expect(r.errors.some((e) => e.message.match(/already posted/i))).toBe(true);
    expect(r.errors.some((e) => e.message.match(/does not match any product/i))).toBe(true);
    expect(r.valid).toHaveLength(0);
  });
});

describe("fieldsFor", () => {
  it("exposes required flags used by the wizard's mapping step", () => {
    expect(fieldsFor("products").filter((f) => f.required).map((f) => f.field).sort())
      .toEqual(["name", "sku"]);
    expect(fieldsFor("opening_stock").filter((f) => f.required).map((f) => f.field).sort())
      .toEqual(["qty", "sku"]);
  });
});
