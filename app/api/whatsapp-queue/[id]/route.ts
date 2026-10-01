import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { whatsappQueue } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError, UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const patchSchema = z.object({
  // QUEUED → OPENED (user clicked the wa.me link) → SENT (user confirms it
  // went out) or FAILED. No API key exists, so delivery is human-confirmed.
  status: z.enum(["QUEUED", "OPENED", "SENT", "FAILED"]),
});

// PATCH /api/whatsapp-queue/[id] — advance a queued message's status
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const { id } = await params;
    const parsed = patchSchema.safeParse(await req.json());
    if (!parsed.success) throw new UserError("Invalid status.", 422, "INVALID_STATUS");
    const patch: Record<string, unknown> = { status: parsed.data.status };
    if (parsed.data.status === "OPENED") patch.openedAt = new Date();
    if (parsed.data.status === "SENT") patch.sentAt = new Date();
    const updated = await db
      .update(whatsappQueue)
      .set(patch)
      .where(and(eq(whatsappQueue.id, id), eq(whatsappQueue.companyId, gate.companyId)))
      .returning({ id: whatsappQueue.id, status: whatsappQueue.status });
    if (updated.length === 0) return err("Message not found.", 404);
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "whatsapp.queue.status",
      entity: "whatsapp_queue",
      entityId: id,
      detail: parsed.data.status,
      ip: clientIp(req),
    });
    return json({ data: updated[0] });
  } catch (e) {
    return toApiError(e, { route: "/api/whatsapp-queue/[id]", companyId: gate.companyId });
  }
}
