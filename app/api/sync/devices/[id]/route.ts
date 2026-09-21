// Revoke an enrolled sync device (sets revoked_at; the row is kept for audit).
// Owners may revoke any device in the company; staff may revoke only their own.
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { deviceTokens, users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;

  const [tok] = await db.select().from(deviceTokens).where(eq(deviceTokens.id, id)).limit(1);
  if (!tok || tok.companyId !== gate.companyId) return err("Device not found.", 404);

  const [u] = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, gate.session.uid))
    .limit(1);
  const isOwner = u?.role === "OWNER";
  if (!isOwner && tok.userId !== gate.session.uid) {
    return err("You can only revoke your own devices.", 403);
  }

  if (tok.revokedAt) return json({ ok: true }); // idempotent

  await db.update(deviceTokens).set({ revokedAt: new Date() }).where(eq(deviceTokens.id, id));

  const [revoker] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, gate.session.uid))
    .limit(1);
  await logAudit(db, {
    companyId: gate.companyId,
    userId: gate.session.uid,
    userName: revoker?.name ?? "",
    action: "sync.revoke",
    entity: "device",
    entityId: id,
    detail: tok.deviceName || "Unnamed device",
  });

  return json({ ok: true });
}
