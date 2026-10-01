import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { whatsappQueue, salesDocs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/whatsapp-queue — outbox list (newest first, company-scoped)
export async function GET(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const status = req.nextUrl.searchParams.get("status");
    const conds = [eq(whatsappQueue.companyId, gate.companyId)];
    if (status && ["QUEUED", "OPENED", "SENT", "FAILED"].includes(status)) {
      conds.push(eq(whatsappQueue.status, status));
    }
    const rows = await db
      .select({
        id: whatsappQueue.id,
        phone: whatsappQueue.phone,
        intlPhone: whatsappQueue.intlPhone,
        message: whatsappQueue.message,
        waLink: whatsappQueue.waLink,
        status: whatsappQueue.status,
        createdAt: whatsappQueue.createdAt,
        sentAt: whatsappQueue.sentAt,
        docNo: salesDocs.docNo,
      })
      .from(whatsappQueue)
      .leftJoin(salesDocs, eq(salesDocs.id, whatsappQueue.invoiceId))
      .where(and(...conds))
      .orderBy(desc(whatsappQueue.createdAt))
      .limit(100);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/whatsapp-queue", companyId: gate.companyId });
  }
}
