import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { orderReceiptSummary } from "@/lib/purchase-orders";
import { toApiError } from "@/lib/errors";

// GET /api/purchases/[id]/receipt-summary — per-order-line open quantities
// (ordered / received / damaged / open) for the GRN Receive dialog.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  try {
    const data = await db.transaction(async (tx) => {
      const summary = await orderReceiptSummary(tx, companyId, id);
      return summary.map((s) => ({
        itemId: s.itemId,
        ordered: s.ordered.toString(),
        received: s.received.toString(),
        damaged: s.damaged.toString(),
        open: s.open.toString(),
      }));
    });
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases/[id]/receipt-summary", companyId });
  }
}
