import { NextRequest } from "next/server";
import { json, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { getPortalProducts } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// GET /api/portal/[token]/products — active products with sale prices, for the
// portal order form. ORDER access: viewing is harmless for VIEW_ONLY tokens
// too (prices are already on their invoices), but the form itself gates on ORDER.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const rows = await getPortalProducts(db, gate.ctx.token.companyId);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/products" });
  }
}
