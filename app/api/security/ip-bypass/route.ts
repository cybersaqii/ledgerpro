import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireOwner, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { listBypassUsers, addBypassUser, removeBypassUser } from "@/lib/ip-allowlist";

// GET /api/security/ip-bypass — list users with an explicit IP bypass.
// POST /api/security/ip-bypass {userId} — grant a bypass.
// DELETE /api/security/ip-bypass?userId= — revoke a bypass.
// Owner-only: bypasses punch holes in the company firewall.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  try {
    const rows = await listBypassUsers(db, gate.companyId);
    return json({
      data: rows.map((r) => ({
        userId: r.userId,
        name: r.name,
        email: r.email,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-bypass" });
  }
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const parsed = z.object({ userId: z.string().min(1) }).safeParse(body);
    if (!parsed.success) return err("Choose a user.", 422, "VALIDATION_ERROR");
    await db.transaction((tx) => addBypassUser(tx, companyId, parsed.data.userId, session.uid));
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "security.ip_bypass.granted",
      entity: "user",
      entityId: parsed.data.userId,
      detail: "IP allowlist bypass granted",
      ip: clientIp(req),
    });
    return json({ data: { userId: parsed.data.userId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-bypass" });
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const userId = req.nextUrl.searchParams.get("userId")?.trim();
  if (!userId) return err("Choose a user.", 422, "VALIDATION_ERROR");
  try {
    await db.transaction((tx) => removeBypassUser(tx, companyId, userId));
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "security.ip_bypass.revoked",
      entity: "user",
      entityId: userId,
      detail: "IP allowlist bypass revoked",
      ip: clientIp(req),
    });
    return json({ data: { userId } });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-bypass" });
  }
}
