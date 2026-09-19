import { NextRequest, NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { parties, products } from "@/db/schema";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// POST /api/import — CSV import for products and parties.
// multipart/form-data: file (CSV), kind=products|parties.
// Products columns: SKU, Name, Barcode, Category, Unit, Purchase Price, Sale Price, Track Stock
// Parties columns: Name, Type (CUSTOMER/SUPPLIER), Phone, Email, Address, City, Credit Limit
// Returns { imported, skipped, errors[] } — valid rows import, bad rows are reported.

const MAX_ROWS = 2000;
const MAX_BYTES = 2 * 1024 * 1024;

function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (inQuotes) {
      if (ch === '"') {
        if (t[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell); cell = "";
    } else if (ch === "\n") {
      row.push(cell); rows.push(row); row = []; cell = "";
    } else if (ch === "\r") {
      // ignore; \n handles the break
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  // drop trailing empty row
  if (!(row.length === 1 && row[0].trim() === "")) rows.push(row);
  return rows;
}

function normHeader(h: string): string {
  return h.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function moneyOk(v: string): boolean {
  return /^\d{1,12}(\.\d{1,2})?$/.test(v.trim());
}

export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const form = await req.formData().catch(() => null);
  const kind = form?.get("kind");
  const file = form?.get("file");
  if (kind !== "products" && kind !== "parties") return err("Choose what to import: products or parties.", 422);
  if (!(file instanceof File)) return err("Please attach a CSV file.", 422);
  if (file.size > MAX_BYTES) return err("File is too large (max 2 MB).", 422);

  const text = await file.text().catch(() => "");
  if (!text.trim()) return err("The file is empty.", 422);
  const rows = parseCSV(text);
  if (rows.length < 2) return err("No data rows found. Keep the header row and add data below it.", 422);
  if (rows.length - 1 > MAX_ROWS) return err(`Too many rows (max ${MAX_ROWS}). Split the file and try again.`, 422);

  const headers = rows[0].map(normHeader);
  const idx = (names: string[]): number => {
    for (const n of names) {
      const i = headers.indexOf(normHeader(n));
      if (i >= 0) return i;
    }
    return -1;
  };
  const cell = (r: string[], i: number): string => (i >= 0 && i < r.length ? r[i].trim() : "");

  const errors: { row: number; message: string }[] = [];
  let imported = 0;
  let skipped = 0;

  if (kind === "products") {
    const iSku = idx(["sku", "code"]);
    const iName = idx(["name", "productname", "product"]);
    const iBarcode = idx(["barcode"]);
    const iCat = idx(["category"]);
    const iUnit = idx(["unit"]);
    const iPP = idx(["purchaseprice", "purchase", "cost"]);
    const iSP = idx(["saleprice", "sale", "price", "rate"]);
    const iTrack = idx(["trackstock", "track", "stock"]);
    if (iSku < 0 || iName < 0) return err("The CSV needs at least SKU and Name columns.", 422);

    type PRow = { sku: string; name: string; barcode: string | null; category: string | null; unit: string; pp: bigint; sp: bigint; track: boolean };
    const valid: PRow[] = [];
    const seen = new Set<string>();
    rows.slice(1).forEach((r, k) => {
      const rowNo = k + 2;
      if (r.every((c) => !c.trim())) { skipped++; return; }
      const sku = cell(r, iSku);
      const name = cell(r, iName);
      if (!sku) { errors.push({ row: rowNo, message: "SKU is required." }); return; }
      if (name.length < 2) { errors.push({ row: rowNo, message: "Name is too short." }); return; }
      if (sku.length > 40) { errors.push({ row: rowNo, message: "SKU is too long (max 40)." }); return; }
      const ppS = cell(r, iPP) || "0";
      const spS = cell(r, iSP) || "0";
      if (!moneyOk(ppS) || !moneyOk(spS)) { errors.push({ row: rowNo, message: "Prices must be numbers like 250 or 250.50." }); return; }
      const key = sku.toLowerCase();
      if (seen.has(key)) { errors.push({ row: rowNo, message: `Duplicate SKU "${sku}" in this file.` }); return; }
      seen.add(key);
      const unit = (cell(r, iUnit) || "PCS").slice(0, 12);
      const trackRaw = cell(r, iTrack).toLowerCase();
      valid.push({
        sku, name,
        barcode: cell(r, iBarcode) || null,
        category: cell(r, iCat) || null,
        unit,
        pp: parseMoney(ppS), sp: parseMoney(spS),
        track: trackRaw === "" ? true : ["yes", "y", "true", "1"].includes(trackRaw),
      });
    });

    const existing = valid.length
      ? await db
          .select({ sku: products.sku })
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.sku, valid.map((v) => v.sku))))
      : [];
    const existingSet = new Set(existing.map((e) => e.sku.toLowerCase()));
    const fresh = valid.filter((v) => {
      if (existingSet.has(v.sku.toLowerCase())) { skipped++; return false; }
      return true;
    });

    if (fresh.length) {
      await db.insert(products).values(
        fresh.map((v) => ({
          id: crypto.randomUUID(),
          companyId,
          sku: v.sku,
          name: v.name,
          barcode: v.barcode,
          category: v.category,
          unit: v.unit,
          purchasePrice: v.pp,
          salePrice: v.sp,
          trackStock: v.track,
          isActive: true,
        }))
      );
      imported = fresh.length;
    }
  } else {
    const iName = idx(["name", "partyname", "party", "customer"]);
    const iKind = idx(["type", "kind"]);
    const iPhone = idx(["phone", "mobile"]);
    const iEmail = idx(["email"]);
    const iAddr = idx(["address"]);
    const iCity = idx(["city"]);
    const iCL = idx(["creditlimit", "limit", "credit"]);
    if (iName < 0) return err("The CSV needs at least a Name column.", 422);

    type PaRow = { kind: "CUSTOMER" | "SUPPLIER"; name: string; phone: string | null; email: string | null; address: string | null; city: string | null; cl: bigint };
    const valid: PaRow[] = [];
    const seen = new Set<string>();
    rows.slice(1).forEach((r, k) => {
      const rowNo = k + 2;
      if (r.every((c) => !c.trim())) { skipped++; return; }
      const name = cell(r, iName);
      if (name.length < 2) { errors.push({ row: rowNo, message: "Name is too short." }); return; }
      const kindRaw = cell(r, iKind).toUpperCase();
      const kindV: "CUSTOMER" | "SUPPLIER" =
        kindRaw === "" || kindRaw.startsWith("CUST") ? "CUSTOMER" : kindRaw.startsWith("SUPP") ? "SUPPLIER" : "CUSTOMER";
      if (kindRaw && kindV === "CUSTOMER" && !kindRaw.startsWith("CUST")) {
        errors.push({ row: rowNo, message: `Type must be CUSTOMER or SUPPLIER, got "${cell(r, iKind)}".` });
        return;
      }
      const clS = cell(r, iCL) || "0";
      if (!moneyOk(clS)) { errors.push({ row: rowNo, message: "Credit limit must be a number." }); return; }
      const key = `${kindV}:${name.toLowerCase()}`;
      if (seen.has(key)) { errors.push({ row: rowNo, message: `Duplicate "${name}" in this file.` }); return; }
      seen.add(key);
      valid.push({
        kind: kindV, name,
        phone: cell(r, iPhone) || null,
        email: cell(r, iEmail) || null,
        address: cell(r, iAddr) || null,
        city: cell(r, iCity) || null,
        cl: parseMoney(clS),
      });
    });

    const existing = valid.length
      ? await db
          .select({ name: parties.name, kind: parties.kind })
          .from(parties)
          .where(and(eq(parties.companyId, companyId), inArray(parties.name, [...new Set(valid.map((v) => v.name))])))
      : [];
    const existingSet = new Set(existing.map((e) => `${e.kind}:${e.name.toLowerCase()}`));
    const fresh = valid.filter((v) => {
      if (existingSet.has(`${v.kind}:${v.name.toLowerCase()}`)) { skipped++; return false; }
      return true;
    });

    if (fresh.length) {
      await db.insert(parties).values(
        fresh.map((v) => ({
          id: crypto.randomUUID(),
          companyId,
          kind: v.kind,
          name: v.name,
          phone: v.phone,
          email: v.email,
          address: v.address,
          city: v.city,
          creditLimit: v.cl,
          balance: 0n,
          isActive: true,
        }))
      );
      imported = fresh.length;
    }
  }

  return json({ data: { imported, skipped, errors: errors.slice(0, 50), errorCount: errors.length } });
}

// GET /api/import/template?kind=products|parties — sample CSV to fill in
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const kind = req.nextUrl.searchParams.get("kind");
  if (kind === "products") {
    const csv = "SKU,Name,Barcode,Category,Unit,Purchase Price,Sale Price,Track Stock\r\nTEA-001,Test Tea,,Grocery,PCS,200,250,Yes\r\n";
    return new NextResponse("\uFEFF" + csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="products-template.csv"' },
    });
  }
  if (kind === "parties") {
    const csv = "Name,Type,Phone,Email,Address,City,Credit Limit\r\nAhmed Store,CUSTOMER,03001234567,,,Lahore,50000\r\n";
    return new NextResponse("\uFEFF" + csv, {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="parties-template.csv"' },
    });
  }
  return NextResponse.json({ error: "Unknown template kind." }, { status: 400 });
}
