// GET /api/manufacturing/work-orders?status= — list work orders.
// POST /api/manufacturing/work-orders — create a DRAFT work order (idempotent).
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { createWorkOrder, listWorkOrders } from "@/lib/manufacturing";
import { parseQty } from "@/lib/qty";
import { extractIdempotencyKey } from "@/lib/idempotency";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const createSchema = z.object({
  branchId: z.string().min(1),
  productId: z.string().min(1),
  qty: z.union([z.string(), z.number()]), // planned finished output, units
  bomId: z.string().min(1).optional(),
  notes: z.string().max(500).optional(),
});

export async function GET(req: NextRequest) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const status = new URL(req.url).searchParams.get("status") || undefined;
  try {
    const rows = await listWorkOrders(db, gate.companyId, status);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders", companyId: gate.companyId });
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid work order.", 422);
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders", companyId });
  }
  try {
    const r = await db.transaction((tx) =>
      createWorkOrder(tx, {
        companyId,
        branchId: b.data.branchId,
        productId: b.data.productId,
        qtyMilli: parseQty(b.data.qty),
        bomId: b.data.bomId,
        notes: b.data.notes,
        createdById: session.uid,
        idempotencyKey: idemKey,
      })
    );
    if (!r.replay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "manufacturing.wo.created", entity: "work_order", entityId: r.id,
        detail: r.woNo, ip: clientIp(req),
      });
    }
    return json({ data: r, ...(r.replay ? { idempotentReplay: true } : {}) }, { status: r.replay ? 200 : 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/work-orders", companyId });
  }
}
