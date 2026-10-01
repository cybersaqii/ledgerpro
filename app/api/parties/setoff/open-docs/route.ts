import { NextRequest } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { parties, salesDocs, purchaseDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/parties/setoff/open-docs?customerId=&supplierId=
// Contra wizard data: the customer's open invoices and the supplier's open
// bills, each with its outstanding amount, plus the nettable maximum.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const customerId = sp.get("customerId");
  const supplierId = sp.get("supplierId");
  if (!customerId || !supplierId) return err("customerId and supplierId are required.", 422);

  const [customer] = await db
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, customerId), eq(parties.companyId, companyId)))
    .limit(1);
  const [supplier] = await db
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, supplierId), eq(parties.companyId, companyId)))
    .limit(1);
  if (!customer || customer.kind !== "CUSTOMER") return err("Customer not found.", 404);
  if (!supplier || supplier.kind !== "SUPPLIER") return err("Supplier not found.", 404);

  const invoices = await db
    .select({
      id: salesDocs.id,
      docNo: salesDocs.docNo,
      date: salesDocs.date,
      dueDate: salesDocs.dueDate,
      grandTotal: salesDocs.grandTotal,
      amountPaid: salesDocs.amountPaid,
      returnedTotal: salesDocs.returnedTotal,
      writtenOffAmount: salesDocs.writtenOffAmount,
    })
    .from(salesDocs)
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.partyId, customerId),
        eq(salesDocs.docType, "INVOICE"),
        // Only posted-side docs can be netted — DRAFT, PENDING_APPROVAL and
        // REJECTED docs have no journal behind them.
        inArray(salesDocs.status, ["POSTED", "PARTIAL"])
      )
    )
    .orderBy(salesDocs.date);

  const bills = await db
    .select({
      id: purchaseDocs.id,
      docNo: purchaseDocs.docNo,
      date: purchaseDocs.date,
      dueDate: purchaseDocs.dueDate,
      grandTotal: purchaseDocs.grandTotal,
      amountPaid: purchaseDocs.amountPaid,
      returnedTotal: purchaseDocs.returnedTotal,
    })
    .from(purchaseDocs)
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.partyId, supplierId),
        eq(purchaseDocs.docType, "BILL"),
        // Only posted-side docs can be netted — DRAFT, PENDING_APPROVAL and
        // REJECTED docs have no journal behind them.
        inArray(purchaseDocs.status, ["POSTED", "PARTIAL"])
      )
    )
    .orderBy(purchaseDocs.date);

  const openInvoices = invoices
    .map((d) => ({
      id: d.id,
      docNo: d.docNo,
      date: d.date,
      dueDate: d.dueDate,
      outstanding: (BigInt(d.grandTotal) - BigInt(d.amountPaid) - BigInt(d.returnedTotal) - BigInt(d.writtenOffAmount)).toString(),
    }))
    .filter((d) => BigInt(d.outstanding) > 0n);
  const openBills = bills
    .map((d) => ({
      id: d.id,
      docNo: d.docNo,
      date: d.date,
      dueDate: d.dueDate,
      outstanding: (BigInt(d.grandTotal) - BigInt(d.amountPaid) - BigInt(d.returnedTotal)).toString(),
    }))
    .filter((d) => BigInt(d.outstanding) > 0n);

  const receivable = BigInt(customer.balance); // +ve = they owe us
  const payable = BigInt(supplier.balance); // +ve = we owe them
  const maxSetoff = receivable > 0n && payable > 0n ? (receivable < payable ? receivable : payable) : 0n;

  return json({
    data: {
      customer: { id: customer.id, name: customer.name, receivable: receivable.toString() },
      supplier: { id: supplier.id, name: supplier.name, payable: payable.toString() },
      openInvoices,
      openBills,
      maxSetoff: maxSetoff.toString(),
    },
  });
}
