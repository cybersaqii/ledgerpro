import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { billingPayments, companies } from "@/db/schema";
import { db } from "@/lib/route-helpers";
import { json } from "@/lib/api";
import { requirePlatformAdmin } from "@/lib/billing-guards";

// GET /api/admin/billing/payments?status=PENDING — platform admin: all payment submissions.
export async function GET(req: NextRequest) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const status = req.nextUrl.searchParams.get("status")?.toUpperCase();
  const rows = await db
    .select({
      id: billingPayments.id,
      companyId: billingPayments.companyId,
      companyName: companies.name,
      userId: billingPayments.userId,
      amountPaisa: billingPayments.amountPaisa,
      method: billingPayments.method,
      reference: billingPayments.reference,
      months: billingPayments.months,
      status: billingPayments.status,
      note: billingPayments.note,
      reviewedBy: billingPayments.reviewedBy,
      reviewedAt: billingPayments.reviewedAt,
      createdAt: billingPayments.createdAt,
    })
    .from(billingPayments)
    .innerJoin(companies, eq(billingPayments.companyId, companies.id))
    .where(status ? eq(billingPayments.status, status) : undefined)
    .orderBy(desc(billingPayments.createdAt))
    .limit(100);
  return json({ data: rows });
}
