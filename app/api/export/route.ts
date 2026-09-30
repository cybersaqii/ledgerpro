import { NextRequest, NextResponse } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import {
  accounts, parties, products, bankAccounts,
  salesDocs, purchaseDocs,
  payments, expenses,
  stockLevels,
} from "@/db/schema";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { buildBackupPayload, serializeBackup } from "@/lib/backup";
import { rowsToCsv, csvMoney, csvQty, csvDate } from "@/lib/csv";


// GET /api/export?kind=backup|parties|products|sales|purchases|payments|expenses|stock
// - backup: full company JSON (owner-only — it contains everything)
// - others: CSV for spreadsheets

const CSV_KINDS = ["parties", "products", "sales", "purchases", "payments", "expenses", "stock"] as const;


export async function GET(req: NextRequest) {
  const kind = req.nextUrl.searchParams.get("kind") ?? "";
  // Full-data backup is owner-only; per-list CSV exports stay staff-accessible.
  const gate = kind === "backup" ? await requirePermission("import_export") : await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  if (kind === "backup") {
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;

    const { payload } = await buildBackupPayload(db, companyId);
    const body = serializeBackup(payload);
    return new NextResponse(body, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="ledgerpro-backup-${csvDate(new Date())}.json"`,
 },
 });
 }

  if (!(CSV_KINDS as readonly string[]).includes(kind)) {
    return NextResponse.json({ error: "Unknown export kind." }, { status: 400 });
 }

  let csv = "";
  const name = `ledgerpro-${kind}-${csvDate(new Date())}.csv`;

  if (kind === "parties") {
    const rows = await db.select().from(parties).where(eq(parties.companyId, companyId));
    csv = rowsToCsv(
      ["Name", "Type", "Phone", "Email", "Address", "City", "Credit Limit (Rs)", "Balance (Rs)", "Active"],
      rows.map((p) => [p.name, p.kind, p.phone, p.email, p.address, p.city, csvMoney(p.creditLimit), csvMoney(p.balance), p.isActive ? "Yes" : "No"])
    );
 } else if (kind === "products") {
    const rows = await db.select().from(products).where(eq(products.companyId, companyId));
    csv = rowsToCsv(
      ["SKU", "Barcode", "Name", "Category", "Unit", "Purchase Price (Rs)", "Sale Price (Rs)", "Min Sale Price (Rs)", "Track Stock", "Location", "Active"],
      rows.map((p) => [p.sku, p.barcode, p.name, p.category, p.unit, csvMoney(p.purchasePrice), csvMoney(p.salePrice), csvMoney(p.minSalePrice), p.trackStock ? "Yes" : "No", p.location, p.isActive ? "Yes" : "No"])
    );
 } else if (kind === "sales") {
    const rows = await db
      .select({ d: salesDocs, partyName: parties.name })
      .from(salesDocs)
      .leftJoin(parties, eq(salesDocs.partyId, parties.id))
      .where(and(eq(salesDocs.companyId, companyId), eq(salesDocs.docType, "INVOICE")))
      .orderBy(desc(salesDocs.date));
    csv = rowsToCsv(
      ["Invoice No", "Date", "Customer", "Subtotal (Rs)", "Discount (Rs)", "Tax (Rs)", "Total (Rs)", "Paid (Rs)", "Status", "Notes"],
      rows.map((r) => [r.d.docNo, csvDate(r.d.date), r.partyName, csvMoney(r.d.subtotal), csvMoney(r.d.discountTotal), csvMoney(r.d.taxTotal), csvMoney(r.d.grandTotal), csvMoney(r.d.amountPaid), r.d.status, r.d.notes])
    );
 } else if (kind === "purchases") {
    const rows = await db
      .select({ d: purchaseDocs, partyName: parties.name })
      .from(purchaseDocs)
      .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
      .where(and(eq(purchaseDocs.companyId, companyId), eq(purchaseDocs.docType, "BILL")))
      .orderBy(desc(purchaseDocs.date));
    csv = rowsToCsv(
      ["Bill No", "Date", "Supplier", "Subtotal (Rs)", "Discount (Rs)", "Tax (Rs)", "Total (Rs)", "Paid (Rs)", "Status"],
      rows.map((r) => [r.d.docNo, csvDate(r.d.date), r.partyName, csvMoney(r.d.subtotal), csvMoney(r.d.discountTotal), csvMoney(r.d.taxTotal), csvMoney(r.d.grandTotal), csvMoney(r.d.amountPaid), r.d.status])
    );
 } else if (kind === "payments") {
    const rows = await db
      .select({ p: payments, partyName: parties.name, bankName: bankAccounts.name })
      .from(payments)
      .leftJoin(parties, eq(payments.partyId, parties.id))
      .leftJoin(bankAccounts, eq(payments.bankAccountId, bankAccounts.id))
      .where(eq(payments.companyId, companyId))
      .orderBy(desc(payments.date));
    csv = rowsToCsv(
      ["Date", "Type", "Party", "Cash/Bank Account", "Method", "Amount (Rs)", "Reference", "Notes"],
      rows.map((r) => [csvDate(r.p.date), r.p.kind, r.partyName, r.bankName, r.p.method, csvMoney(r.p.amount), r.p.reference, r.p.notes])
    );
 } else if (kind === "expenses") {
    const rows = await db
      .select({ e: expenses, accName: accounts.name, bankName: bankAccounts.name })
      .from(expenses)
      .leftJoin(accounts, eq(expenses.accountId, accounts.id))
      .leftJoin(bankAccounts, eq(expenses.bankAccountId, bankAccounts.id))
      .where(eq(expenses.companyId, companyId))
      .orderBy(desc(expenses.date));
    csv = rowsToCsv(
      ["Date", "Expense Head", "Paid From", "Amount (Rs)", "Tax (Rs)", "Notes"],
      rows.map((r) => [csvDate(r.e.date), r.accName, r.bankName, csvMoney(r.e.amount), csvMoney(r.e.taxAmount), r.e.notes])
    );
 } else if (kind === "stock") {
    const rows = await db
      .select({ s: stockLevels, p: products })
      .from(stockLevels)
      .innerJoin(products, eq(stockLevels.productId, products.id))
      .where(eq(products.companyId, companyId));
    csv = rowsToCsv(
      ["SKU", "Product", "Unit", "Quantity", "Avg Cost (Rs)", "Value (Rs)"],
      rows.map((r) => [r.p.sku, r.p.name, r.p.unit, csvQty(r.s.qty), csvMoney(r.s.avgCost), csvMoney((r.s.qty * r.s.avgCost) / 1000n)])
    );
 }

  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
 },
 });
}
