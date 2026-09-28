// Revoke an enrolled sync device (sets revoked_at; the row is kept for audit).
// Owners may revoke any device in the company; staff may revoke only their own
// (this covers a device revoking itself — the "log out this device" flow).
// Auth: cookie session (web) or device token (requireCompanyOrDevice) —
// the Bearer path is PRO/trial-gated via requireDevice().
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deviceTokens } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompanyOrDevice } from "@/lib/sync-auth";
import { logAudit } from "@/lib/audit";

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCompanyOrDevice(req);
  if (!gate.ok) return gate.response;

  const [tok] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, id)).limit(1);
  if (!tok || tok.companyId !== gate.companyId) return err("Device not found.", 404);

  if (!gate.isOwner && tok.userId !== gate.userId) {
    return err("You can only revoke your own devices.", 403);
  }

  if (tok.revokedAt) return json({ ok: true }); // idempotent

  await db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, id));

  await logAudit(db, {
    companyId: gate.companyId,
    userId: gate.userId,
    userName: gate.userName,
    action: "sync.revoke",
    entity: "device",
    entityId: id,
    detail: tok.deviceName || "Unnamed device",
  });

  return json({ ok: true });
}
