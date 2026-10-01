import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { collectionPriority } from "@/lib/credit-control";

// GET /api/credit-control/priority — payment-priority suggestions: customers
// with open invoices ranked riskiest-first. Permission: reports_basic.
export async function GET() {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  try {
    const data = await collectionPriority(db, gate.companyId);
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/credit-control/priority" });
  }
}
