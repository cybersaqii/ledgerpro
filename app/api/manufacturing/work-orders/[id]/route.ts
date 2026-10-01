// GET /api/manufacturing/work-orders/[id] — detail (WO + snapshot components).
// PATCH /api/manufacturing/work-orders/[id] — edit a DRAFT work order.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { getWorkOrderDetail, updateWorkOrder } from "@/lib/manufacturing";
import { parseQty } from "@/lib/qty";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const data = await getWorkOrderDetail(db, gate.companyId, id);
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]", companyId: gate.companyId });
  }
}

const patchSchema = z.object({
  qty: z.union([z.string(), z.number()]).optional(),
  branchId: z.string().min(1).optional(),
  notes: z.string().max(500).nullable().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid request.", 422);
  try {
    await db.transaction((tx) =>
      updateWorkOrder(tx, {
        companyId,
        workOrderId: id,
        qtyMilli: b.data.qty !== undefined ? parseQty(b.data.qty) : undefined,
        branchId: b.data.branchId,
        notes: b.data.notes === undefined ? undefined : (b.data.notes ?? null),
      })
    );
    return json({ data: { ok: true } });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders/[id]", companyId });
  }
}
