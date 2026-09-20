import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import {
  STAFF_DEFAULT_PERMISSIONS,
  getUserPermissions,
  setUserPermissions,
  liveUserRole,
  isPermission,
} from "@/lib/permissions";

// GET /api/users — list company users (owner, or staff with the team permission)
export async function GET() {
  const gate = await requirePermission("team");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("team");
  if (!pro.ok) return pro.response;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.companyId, companyId));
  const data = [];
  for (const u of rows) {
    data.push({ ...u, permissions: u.role === "OWNER" ? "ALL" : await getUserPermissions(db, u.id) });
  }
  return json({ data });
}

// POST /api/users — add a staff member (owner, or staff with the team permission).
// Only an OWNER may assign a custom permission set; a team-manager's new staff
// always starts with the default staff permissions. Role is always STAFF here.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("team");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const pro = await requirePro("team");
  if (!pro.ok) return pro.response;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (name.length < 2) return err("Enter the staff member's name.", 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.", 422);
  if (password.length < 8) return err("Password must be at least 8 characters.", 422);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return err("This email is already registered.", 409);

  const callerRole = await liveUserRole(db, session.uid);
  let permissions = [...STAFF_DEFAULT_PERMISSIONS];
  if (Array.isArray(body?.permissions)) {
    if (callerRole !== "OWNER") return err("Only the owner can set custom permissions.", 403);
    const clean = [...new Set((body.permissions as string[]).filter(isPermission))];
    if (clean.length === 0) return err("Pick at least one permission for the new staff member.", 422);
    permissions = clean;
  }

  const userId = crypto.randomUUID();
  await db.transaction(async (tx) => {
    await tx.insert(users).values({
      id: userId,
      companyId,
      name,
      email,
      passwordHash: await hashPassword(password),
      role: "STAFF",
      isActive: true,
    });
    await setUserPermissions(tx, { companyId, userId, permissions });
  });
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "user.invited", entity: "user", entityId: userId,
    detail: `Staff member ${name} <${email}> added (${permissions.length} permissions)`,
  });
  return json({ data: { id: userId } }, { status: 201 });
}
