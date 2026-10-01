import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { deliverChallan, logChallanAction } from "@/lib/challan";

// POST /api/sales/[id]/deliver — mark a dispatched challan delivered
// (DISPATCHED → DELIVERED). Status stamp only — stock already moved at
// dispatch.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  try {
    const result = await db.transaction((tx) =>
      deliverChallan(tx, { companyId, challanId: id, userId: session.uid })
    );
    await logChallanAction(db, {
      companyId,
      challanId: id,
      userId: session.uid,
      userName: session.name,
      action: "sale.challan_delivered",
      detail: "Challan marked delivered",
    });
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/deliver", companyId });
  }
}
