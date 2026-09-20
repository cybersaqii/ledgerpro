import { NextRequest } from "next/server";
import { deleteHeldBill } from "@/lib/held";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

// DELETE /api/pos/held/:id — remove a held bill (owner of the bill, or company owner).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("held_bills");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const ok = await deleteHeldBill(db, { companyId, userId: session.uid, role: session.role, id });
  if (!ok) return err("Held bill not found.", 404);
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "pos.held_deleted",
    entity: "held_bill",
    entityId: id,
    detail: "Held bill removed",
  });
  return json({ data: { ok: true } });
}
