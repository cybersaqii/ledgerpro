import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { users, userCompanies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireOwner, requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { logAudit } from "@/lib/audit";
import {
  setUserPermissions,
  ensureStaffDefaults,
  isPermission,
} from "@/lib/permissions";

// PATCH /api/users/[id] — manage a team member.
//   role / permissions → OWNER only (privilege changes never delegated).
//   isActive → owner, or staff with the team permission (never on owners, never self).
//     Global deactivation: also flips this company's membership row, so the
//     link the auth layer honours (getSession requires an active link) never
//     disagrees with the global flag.
//   companyActive → same gate as isActive, but membership-only: false removes
//     the member from THIS company (they vanish from the team list, which
//     only shows active links) without touching their global account, so a
//     staff member in two companies can leave one and keep the other.
// Demoting OWNER → STAFF seeds the default staff grants when the user has no
// explicit rows; promoting STAFF → OWNER keeps existing rows (harmless —
// owners bypass the grant check).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const body = await req.json().catch(() => ({}));
  const wantsPrivilegeChange =
    body.role === "OWNER" || body.role === "STAFF" || Array.isArray(body.permissions);
  const gate = wantsPrivilegeChange ? await requireOwner() : await requirePermission("team");
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
  if (!wantsPrivilegeChange && target.role === "OWNER") {
    return err("Only the owner can change another owner's access.", 403);
  }

  const patch: { role?: string; isActive?: boolean } = {};
  if (body.role === "OWNER" || body.role === "STAFF") patch.role = body.role;
  if (typeof body.isActive === "boolean") patch.isActive = body.isActive;
  const companyActive = typeof body.companyActive === "boolean" ? body.companyActive : null;
  let newPermissions: string[] | null = null;
  if (Array.isArray(body.permissions)) {
    newPermissions = [...new Set((body.permissions as string[]).filter(isPermission))];
  }
  if (Object.keys(patch).length === 0 && newPermissions === null && companyActive === null) {
    return err("Nothing to update.", 422);
  }

  await db.transaction(async (tx) => {
    if (Object.keys(patch).length > 0) {
      await tx.update(users).set(patch).where(eq(users.id, id));
    }
    // The membership row is what getSession() honours: keep it in step with
    // the global flag on deactivate/activate, and honour membership-only
    // removal without touching the global account.
    if (typeof patch.isActive === "boolean") {
      await tx
        .update(userCompanies)
        .set({ isActive: patch.isActive })
        .where(and(eq(userCompanies.userId, id), eq(userCompanies.companyId, companyId)));
    }
    if (companyActive !== null) {
      await tx
        .update(userCompanies)
        .set({ isActive: companyActive })
        .where(and(eq(userCompanies.userId, id), eq(userCompanies.companyId, companyId)));
    }
    if (newPermissions !== null) {
      await setUserPermissions(tx, { companyId, userId: id, permissions: newPermissions });
    } else if (patch.role === "STAFF" && target.role === "OWNER") {
      // Fresh demotion with no explicit grant set: start from the defaults.
      await ensureStaffDefaults(tx, { companyId, userId: id });
    }
  });
  const detailBits = [JSON.stringify(patch)];
  if (companyActive !== null) detailBits.push(`companyActive=${companyActive}`);
  if (newPermissions !== null) detailBits.push(`permissions=[${newPermissions.join(",")}]`);
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "user.updated", entity: "user", entityId: id,
    detail: `${target.name}: ${detailBits.join(" ")}`,
  });
  return json({ data: { id } });
}
