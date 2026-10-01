import { NextRequest } from "next/server";
import { eq, and, asc, inArray } from "drizzle-orm";
import { salesDocs, purchaseDocs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/parties/[id]/outstanding?kind=SALES|PURCHASE — unpaid posted docs for allocation.
// Includes PARTIAL docs (still have a balance); DRAFT, PENDING_APPROVAL and
// REJECTED docs are never allocatable (their journals aren't posted).
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const kind = req.nextUrl.searchParams.get("kind") === "PURCHASE" ? "PURCHASE" : "SALES";

  if (kind === "SALES") {
    const rows = await db
      .select({
        id: salesDocs.id, docNo: salesDocs.docNo, docType: salesDocs.docType,
        date: salesDocs.date, grandTotal: salesDocs.grandTotal, amountPaid: salesDocs.amountPaid,
      })
      .from(salesDocs)
      .where(
        and(
          eq(salesDocs.companyId, companyId),
          eq(salesDocs.partyId, id),
          // Only posted-side statuses are allocatable: POSTED + PARTIAL.
          // DRAFT, PENDING_APPROVAL and REJECTED docs have no journal yet.
          inArray(salesDocs.status, ["POSTED", "PARTIAL"]),
          inArray(salesDocs.docType, ["INVOICE", "RETURN"])
        )
      )
      .orderBy(asc(salesDocs.date), asc(salesDocs.docNo))
      .limit(100);
    const data = rows
      .map((r) => ({ ...r, balance: (r.grandTotal - r.amountPaid).toString() }))
      .filter((r) => BigInt(r.balance) > 0n);
    return json({ data });
  }

  const rows = await db
    .select({
      id: purchaseDocs.id, docNo: purchaseDocs.docNo, docType: purchaseDocs.docType,
      date: purchaseDocs.date, grandTotal: purchaseDocs.grandTotal, amountPaid: purchaseDocs.amountPaid,
    })
    .from(purchaseDocs)
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        eq(purchaseDocs.partyId, id),
        // Only posted-side statuses are allocatable: POSTED + PARTIAL.
        // DRAFT, PENDING_APPROVAL and REJECTED docs have no journal yet.
        inArray(purchaseDocs.status, ["POSTED", "PARTIAL"]),
        inArray(purchaseDocs.docType, ["BILL", "RETURN"])
      )
    )
    .limit(100);
  const data = rows
    .map((r) => ({ ...r, balance: (r.grandTotal - r.amountPaid).toString() }))
    .filter((r) => BigInt(r.balance) > 0n);
  return json({ data });
}
