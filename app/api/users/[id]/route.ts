import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireOwner, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { logAudit } from "@/lib/audit";

// PATCH /api/users/[id] — change role or active status (owner only).
// The owner cannot demote or deactivate themselves.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  if (id === session.uid) return err("You cannot change your own access.", 422);
  const pro = await requirePro("team");
  if (!pro.ok) return pro.response;


  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.companyId, companyId)))
    .limit(1);
  if (!target) return err("User not found.", 404);

  const body = await req.json().catch(() => ({}));
  const patch: { role?: string; isActive?: boolean } = {};
  if (body.role === "OWNER" || body.role === "STAFF") patch.role = body.role;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  if (Object.keys(patch).length === 0) return err("Nothing to update.", 422);

  await db.update(users).set(patch).where(eq(users.id, id));
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "user.updated", entity: "user", entityId: id,
    detail: `${target.name}: ${JSON.stringify(patch)}`,
  });
  return json({ data: { id } });
}
