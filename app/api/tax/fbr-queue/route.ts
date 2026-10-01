import { NextRequest } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { fbrSyncQueue, companies } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { buildFbrQrData, fbrSyncStatus, paisaToRs, rsToPaisa } from "@/lib/fbr";

// GET /api/tax/fbr-queue — outbound FBR digital-invoice payloads.
// Every row reports status DISABLED: the live sync engine does not exist
// (see lib/fbr.ts HARD RULE). The QR data for each invoice is included so
// the UI can render the invoice QR without any live connection.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));
  const where = eq(fbrSyncQueue.companyId, companyId);
  const rows = await db
    .select()
    .from(fbrSyncQueue)
    .where(where)
    .orderBy(desc(fbrSyncQueue.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(fbrSyncQueue)
    .where(where);
  const coRows = await db
    .select({ ntn: companies.ntn })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const companyNtn = coRows[0]?.ntn ?? null;
  const data = rows.map((r) => {
    let payload: {
      InvoiceNumber?: string;
      DateTime?: string;
      TotalSaleValue?: string;
      TotalTaxCharged?: string;
      POSID?: string | null;
      Items?: unknown[];
    } | null = null;
    try {
      payload = JSON.parse(r.payloadJson);
    } catch {
      payload = null;
    }
    // QR data for the invoice (FBR invoice number, NTN, date, total).
    const totalPaisa = rsToPaisa(payload?.TotalSaleValue) + rsToPaisa(payload?.TotalTaxCharged);
    const qrData = buildFbrQrData({
      fbrInvoiceNumber: r.invoiceNumber,
      ntn: companyNtn,
      date: r.createdAt,
      totalPaisa,
    });
    return {
      id: r.id,
      docType: r.docType,
      docId: r.docId,
      invoiceNumber: r.invoiceNumber,
      status: r.status,
      attempts: r.attempts,
      error: r.error,
      createdAt: r.createdAt,
      payload,
      qrData,
      totalRs: paisaToRs(totalPaisa),
    };
  });
  return json({
    data,
    total: total[0]?.n ?? 0,
    page,
    perPage,
    sync: fbrSyncStatus(),
  });
}
