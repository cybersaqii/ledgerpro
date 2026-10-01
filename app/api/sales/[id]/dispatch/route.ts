import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { dispatchChallan, logChallanAction } from "@/lib/challan";

// POST /api/sales/[id]/dispatch — dispatch a draft challan (DRAFT →
// DISPATCHED). Deducts stock at moving average as a stock movement ONLY —
// no journal is posted. Throws on insufficient stock (rolls back).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  try {
    const result = await db.transaction((tx) =>
      dispatchChallan(tx, { companyId, challanId: id, userId: session.uid })
    );
    await logChallanAction(db, {
      companyId,
      challanId: id,
      userId: session.uid,
      userName: session.name,
      action: "sale.challan_dispatched",
      detail: "Challan dispatched — stock moved out (no journal)",
    });
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/dispatch", companyId });
  }
}
