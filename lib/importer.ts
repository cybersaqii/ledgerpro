// Module 20 — universal CSV data import engine (products / parties /
// opening stock).
//
// Two-pass by design:
//   pass 1 — parse the CSV, apply the column mapping, shape every row;
//   pass 2 — validate ALL rows (field rules, in-file duplicates, and
//            duplicates already in the database).
// The API commits ONLY when pass 2 reports zero errors — all-or-nothing, in
// a single transaction. Every commit attempt is written to import_logs.
//
// Excel files are NOT parsed directly: the documented workflow is
// File → Save As → CSV in Excel, then upload the CSV. This keeps one exact
// parser instead of a second binary format.
//
// Money = integer paisa / BigInt only. Every query is company-scoped.
import { and, eq, inArray } from "drizzle-orm";
import { parties, products } from "@/db/schema";
import { parseMoney } from "./money";
import { postOpeningStock } from "./inventory";
import { defaultBranchId } from "./route-helpers";
import { UserError } from "./errors";
import type { Db, DbTx } from "./db";

export type ImportKind = "products" | "parties" | "opening_stock";

export type FieldDef = {
  field: string;
  label: string;
  required: boolean;
  aliases: string[];
};

export const PRODUCT_FIELDS: FieldDef[] = [
  { field: "sku", label: "SKU", required: true, aliases: ["sku", "code", "itemcode"] },
  { field: "name", label: "Name", required: true, aliases: ["name", "productname", "product", "itemname"] },
  { field: "barcode", label: "Barcode", required: false, aliases: ["barcode", "ean"] },
  { field: "category", label: "Category", required: false, aliases: ["category", "group"] },
  { field: "unit", label: "Unit", required: false, aliases: ["unit", "uom"] },
  { field: "purchasePrice", label: "Purchase Price", required: false, aliases: ["purchaseprice", "purchase", "cost", "costprice"] },
  { field: "salePrice", label: "Sale Price", required: false, aliases: ["saleprice", "sale", "price", "rate", "salerate"] },
  { field: "minSalePrice", label: "Min Sale Price", required: false, aliases: ["minsaleprice", "minprice", "floorprice", "minimumprice"] },
  { field: "trackStock", label: "Track Stock", required: false, aliases: ["trackstock", "track", "stock"] },
  { field: "location", label: "Location", required: false, aliases: ["location", "godown", "rack", "godownrack"] },
];

export const PARTY_FIELDS: FieldDef[] = [
  { field: "name", label: "Name", required: true, aliases: ["name", "partyname", "party", "customer", "supplier"] },
  { field: "type", label: "Type", required: false, aliases: ["type", "kind"] },
  { field: "phone", label: "Phone", required: false, aliases: ["phone", "mobile", "contact"] },
  { field: "email", label: "Email", required: false, aliases: ["email"] },
  { field: "address", label: "Address", required: false, aliases: ["address"] },
  { field: "city", label: "City", required: false, aliases: ["city"] },
  { field: "creditLimit", label: "Credit Limit", required: false, aliases: ["creditlimit", "limit", "credit"] },
];

export const OPENING_STOCK_FIELDS: FieldDef[] = [
  { field: "sku", label: "SKU", required: true, aliases: ["sku", "code", "itemcode"] },
  { field: "qty", label: "Quantity", required: true, aliases: ["qty", "quantity", "openingqty", "stock"] },
  { field: "rate", label: "Unit Cost", required: false, aliases: ["rate", "cost", "unitcost", "purchaseprice", "price"] },
];

export function fieldsFor(kind: ImportKind): FieldDef[] {
  return kind === "products" ? PRODUCT_FIELDS : kind === "parties" ? PARTY_FIELDS : OPENING_STOCK_FIELDS;
}

export const MAX_ROWS = 2000;
export const MAX_BYTES = 2 * 1024 * 1024;
export const MAX_ERRORS = 100;

/** Minimal RFC-4180-ish CSV parser (quotes, escaped quotes, CRLF, BOM). */
export function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const t = text.replace(/^﻿/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') {
          cell += '"';
          i++;
        } else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else if (ch === "\r") {
      // ignore; \n handles the break
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  // drop a single trailing empty row
  if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
  return rows;
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z]/g, "");
}

/**
 * Auto-guess the column mapping from the header row: first header whose
 * normalized text matches any alias wins. Returns field → column index
 * (null = unmapped).
 */
export function autoMapFields(
  headers: string[],
  fields: FieldDef[]
): Record<string, number | null> {
  const normed = headers.map(normHeader);
  const out: Record<string, number | null> = {};
  for (const f of fields) {
    let idx: number | null = null;
    for (const a of f.aliases) {
      const i = normed.indexOf(normHeader(a));
      if (i >= 0) {
        idx = i;
        break;
      }
    }
    out[f.field] = idx;
  }
  return out;
}

export type ImportError = { row: number; message: string };

export type ValidProductRow = {
  sku: string;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string;
  purchasePrice: bigint;
  salePrice: bigint;
  minSalePrice: bigint;
  trackStock: boolean;
  location: string | null;
};

export type ValidPartyRow = {
  kind: "CUSTOMER" | "SUPPLIER";
  name: string;
  phone: string | null;
  email: string | null;
  address: string | null;
  city: string | null;
  creditLimit: bigint;
};

export type ValidOpeningStockRow = {
  productId: string;
  sku: string;
  name: string;
  qtyMilli: bigint;
  unitCostPaisa: bigint;
};

export type ValidRow = ValidProductRow | ValidPartyRow | ValidOpeningStockRow;

export type ValidationResult = {
  kind: ImportKind;
  totalRows: number;
  /** rows already in the database (name+phone / SKU) — skipped, not errors */
  skipped: number;
  errors: ImportError[];
  errorCount: number;
  valid: ValidRow[];
};

function moneyOk(v: string): boolean {
  return /^\d{1,12}(\.\d{1,2})?$/.test(v.trim());
}

function qtyOk(v: string): boolean {
  return /^\d{1,12}(\.\d{1,3})?$/.test(v.trim());
}

function parseQtyMilli(v: string): bigint {
  const [w, f = ""] = v.trim().split(".");
  return BigInt(w) * 1000n + BigInt((f + "000").slice(0, 3));
}

function normPhone(p: string | null): string {
  return (p ?? "").replace(/\D/g, "");
}

/**
 * Pass 1+2: shape every row through the column mapping, then validate all
 * rows — field rules, in-file duplicates, and duplicates against the
 * database. Returns every error with its CSV row number (1-based, header =
 * row 1). Commits nothing.
 */
export async function validateImport(
  dbx: Db | DbTx,
  companyId: string,
  kind: ImportKind,
  rows: string[][],
  mapping: Record<string, number | null>
): Promise<ValidationResult> {
  const fields = fieldsFor(kind);
  const errors: ImportError[] = [];
  const err = (row: number, message: string) => {
    if (errors.length < MAX_ERRORS) errors.push({ row, message });
  };
  let errorCount = 0;
  const push = (row: number, message: string) => {
    errorCount++;
    err(row, message);
  };

  // Required fields must be mapped.
  for (const f of fields) {
    if (f.required && mapping[f.field] == null) {
      return {
        kind,
        totalRows: 0,
        skipped: 0,
        errors: [{ row: 1, message: `The CSV needs a "${f.label}" column (map it or add the header).` }],
        errorCount: 1,
        valid: [],
      };
    }
  }

  const col = (r: string[], field: string): string => {
    const i = mapping[field];
    return i == null || i < 0 || i >= r.length ? "" : r[i].trim();
  };

  const dataRows = rows.slice(1);
  const blankRows = dataRows.filter((r) => r.every((c) => !c.trim())).length;
  const totalRows = dataRows.length - blankRows;

  if (kind === "products") {
    const valid: ValidProductRow[] = [];
    const seen = new Map<string, number>();
    dataRows.forEach((r, k) => {
      const rowNo = k + 2;
      if (r.every((c) => !c.trim())) return; // blank rows are skipped, not errors
      const sku = col(r, "sku");
      const name = col(r, "name");
      if (!sku) return push(rowNo, "SKU is required.");
      if (sku.length > 40) return push(rowNo, "SKU is too long (max 40).");
      if (name.length < 2) return push(rowNo, "Name is too short.");
      const key = sku.toLowerCase();
      if (seen.has(key)) return push(rowNo, `Duplicate SKU "${sku}" in this file (first at row ${seen.get(key)}).`);
      seen.set(key, rowNo);
      const ppS = col(r, "purchasePrice") || "0";
      const spS = col(r, "salePrice") || "0";
      const minS = col(r, "minSalePrice") || "0";
      if (!moneyOk(ppS) || !moneyOk(spS) || !moneyOk(minS))
        return push(rowNo, "Prices must be numbers like 250 or 250.50.");
      const trackRaw = col(r, "trackStock").toLowerCase();
      valid.push({
        sku,
        name,
        barcode: col(r, "barcode") || null,
        category: col(r, "category") || null,
        unit: (col(r, "unit") || "PCS").slice(0, 12),
        purchasePrice: parseMoney(ppS),
        salePrice: parseMoney(spS),
        minSalePrice: parseMoney(minS),
        trackStock: trackRaw === "" ? true : ["yes", "y", "true", "1"].includes(trackRaw),
        location: col(r, "location").slice(0, 60) || null,
      });
    });
    // Duplicate detection against the database: SKU. Existing records are
    // skipped (not errors) — the commit is still all-or-nothing on the rest.
    let skipped = blankRows;
    if (valid.length > 0) {
      const existing = await dbx
        .select({ sku: products.sku })
        .from(products)
        .where(
          and(eq(products.companyId, companyId), inArray(products.sku, valid.map((v) => v.sku)))
        );
      const existingSet = new Set(existing.map((e) => e.sku.toLowerCase()));
      const fresh = valid.filter((v) => {
        if (existingSet.has(v.sku.toLowerCase())) {
          skipped++;
          return false;
        }
        return true;
      });
      return { kind, totalRows, skipped, errors, errorCount, valid: fresh };
    }
    return { kind, totalRows, skipped, errors, errorCount, valid };
  }

  if (kind === "parties") {
    const valid: ValidPartyRow[] = [];
    const seen = new Map<string, number>();
    dataRows.forEach((r, k) => {
      const rowNo = k + 2;
      if (r.every((c) => !c.trim())) return;
      const name = col(r, "name");
      if (name.length < 2) return push(rowNo, "Name is too short.");
      const typeRaw = col(r, "type").toUpperCase();
      let pv: "CUSTOMER" | "SUPPLIER" = "CUSTOMER";
      if (typeRaw === "") pv = "CUSTOMER";
      else if (typeRaw.startsWith("CUST")) pv = "CUSTOMER";
      else if (typeRaw.startsWith("SUPP")) pv = "SUPPLIER";
      else return push(rowNo, `Type must be CUSTOMER or SUPPLIER, got "${col(r, "type")}".`);
      const phone = col(r, "phone") || null;
      const key = `${pv}:${name.toLowerCase()}:${normPhone(phone)}`;
      if (seen.has(key))
        return push(rowNo, `Duplicate "${name}"${phone ? ` (${phone})` : ""} in this file (first at row ${seen.get(key)}).`);
      seen.set(key, rowNo);
      const clS = col(r, "creditLimit") || "0";
      if (!moneyOk(clS)) return push(rowNo, "Credit limit must be a number like 50000 or 50000.50.");
      const email = col(r, "email") || null;
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return push(rowNo, `Email "${email}" does not look valid.`);
      valid.push({
        kind: pv,
        name,
        phone,
        email,
        address: col(r, "address") || null,
        city: col(r, "city") || null,
        creditLimit: parseMoney(clS),
      });
    });
    // Duplicate detection against the database: name + phone. Existing
    // records are skipped (not errors).
    let skipped = blankRows;
    if (valid.length > 0) {
      const existing = await dbx
        .select({ name: parties.name, kind: parties.kind, phone: parties.phone })
        .from(parties)
        .where(
          and(
            eq(parties.companyId, companyId),
            inArray(parties.name, [...new Set(valid.map((v) => v.name))])
          )
        );
      const existingSet = new Set(
        existing.map((e) => `${e.kind}:${e.name.toLowerCase()}:${normPhone(e.phone)}`)
      );
      const fresh = valid.filter((v) => {
        if (existingSet.has(`${v.kind}:${v.name.toLowerCase()}:${normPhone(v.phone)}`)) {
          skipped++;
          return false;
        }
        return true;
      });
      return { kind, totalRows, skipped, errors, errorCount, valid: fresh };
    }
    return { kind, totalRows, skipped, errors, errorCount, valid };
  }

  // opening_stock
  const valid: ValidOpeningStockRow[] = [];
  const seen = new Map<string, number>();
  const shaped: { rowNo: number; sku: string; qtyMilli: bigint; unitCostPaisa: bigint }[] = [];
  dataRows.forEach((r, k) => {
    const rowNo = k + 2;
    if (r.every((c) => !c.trim())) return;
    const sku = col(r, "sku");
    if (!sku) return push(rowNo, "SKU is required.");
    const key = sku.toLowerCase();
    if (seen.has(key)) return push(rowNo, `Duplicate SKU "${sku}" in this file (first at row ${seen.get(key)}).`);
    const qtyS = col(r, "qty");
    if (!qtyOk(qtyS)) return push(rowNo, "Quantity must be a number like 10 or 10.500.");
    const qtyMilli = parseQtyMilli(qtyS);
    if (qtyMilli <= 0n) return push(rowNo, "Quantity must be greater than zero.");
    const rateS = col(r, "rate") || "0";
    if (!moneyOk(rateS)) return push(rowNo, "Unit cost must be a number like 250 or 250.50.");
    seen.set(key, rowNo);
    shaped.push({ rowNo, sku, qtyMilli, unitCostPaisa: parseMoney(rateS) });
  });
  if (shaped.length > 0) {
    const prods = await dbx
      .select()
      .from(products)
      .where(
        and(
          eq(products.companyId, companyId),
          inArray(products.sku, shaped.map((s) => s.sku))
        )
      );
    const bySku = new Map(prods.map((p) => [p.sku.toLowerCase(), p]));
    for (const s of shaped) {
      const p = bySku.get(s.sku.toLowerCase());
      if (!p) {
        push(s.rowNo, `SKU "${s.sku}" does not match any product — import the product first.`);
        continue;
      }
      if (p.itemType !== "INVENTORY" || !p.trackStock) {
        push(s.rowNo, `Opening stock needs an inventory-tracked product ("${p.name}").`);
        continue;
      }
      if (p.openingStockPosted) {
        push(s.rowNo, `Opening stock was already posted for "${p.name}".`);
        continue;
      }
      valid.push({
        productId: p.id,
        sku: p.sku,
        name: p.name,
        qtyMilli: s.qtyMilli,
        unitCostPaisa: s.unitCostPaisa,
      });
    }
  }
  return { kind, totalRows, skipped: blankRows, errors, errorCount, valid };
}

export type CommitResult = { imported: number; skipped: number };

/**
 * Commit validated rows — ALL or NOTHING, in one transaction. The caller
 * must pass rows from validateImport with errorCount === 0.
 */
export async function commitImport(
  tx: DbTx,
  companyId: string,
  userId: string,
  kind: ImportKind,
  valid: ValidRow[]
): Promise<CommitResult> {
  if (kind === "products") {
    const rows = valid as ValidProductRow[];
    if (rows.length > 0) {
      await tx.insert(products).values(
        rows.map((v) => ({
          id: crypto.randomUUID(),
          companyId,
          sku: v.sku,
          name: v.name,
          barcode: v.barcode,
          category: v.category,
          unit: v.unit,
          purchasePrice: v.purchasePrice,
          salePrice: v.salePrice,
          trackStock: v.trackStock,
          minSalePrice: v.minSalePrice,
          location: v.location,
          isActive: true,
        }))
      );
    }
    return { imported: rows.length, skipped: 0 };
  }
  if (kind === "parties") {
    const rows = valid as ValidPartyRow[];
    if (rows.length > 0) {
      await tx.insert(parties).values(
        rows.map((v) => ({
          id: crypto.randomUUID(),
          companyId,
          kind: v.kind,
          name: v.name,
          phone: v.phone,
          email: v.email,
          address: v.address,
          city: v.city,
          creditLimit: v.creditLimit,
          balance: 0n,
          isActive: true,
        }))
      );
    }
    return { imported: rows.length, skipped: 0 };
  }
  // opening_stock — posts through the canonical opening-stock engine
  // (Dr Inventory / Cr Opening Equity 3002), one journal per product.
  const rows = valid as ValidOpeningStockRow[];
  if (rows.length > 0) {
    const branchId = await defaultBranchId(tx, companyId);
    const date = new Date();
    for (const v of rows) {
      await postOpeningStock(tx, {
        companyId,
        branchId,
        productId: v.productId,
        qtyMilli: v.qtyMilli,
        unitCostPaisa: v.unitCostPaisa,
        date,
        createdById: userId,
      });
    }
  }
  return { imported: rows.length, skipped: 0 };
}

/** Guard the kind query/body param. */
export function parseKind(raw: unknown): ImportKind {
  if (raw === "products" || raw === "parties" || raw === "opening_stock") return raw;
  throw new UserError("Choose what to import: products, parties or opening_stock.", 422, "VALIDATION_ERROR");
}
