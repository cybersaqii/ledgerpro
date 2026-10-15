import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies } from "@/db/schema";
import { getSession, destroySession } from "@/lib/auth";
import { json, err } from "@/lib/api";
import { getUserPermissions, liveUserRole, PERMISSIONS } from "@/lib/permissions";

export async function GET() {
  const session = await getSession();
  if (!session) return err("Not signed in.", 401);
  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("Session expired.", 401);
  // Multi-company: the active company is the SESSION company, and the role /
  // permissions come from the user's membership row for that company — not
  // from the single-company users.role / users.companyId columns.
  const co = await db
    .select({ name: companies.name, businessType: companies.businessType })
    .from(companies)
    .where(eq(companies.id, session.cid))
    .limit(1);
  const role = await liveUserRole(db, user.id, session.cid);
  if (!role) return err("Session expired.", 401);
  const permissions = role === "OWNER" ? [...PERMISSIONS] : await getUserPermissions(db, user.id, session.cid);
  return json({
    user: { id: user.id, name: user.name, email: user.email, role, permissions },
    company: { id: session.cid, name: co[0]?.name ?? "", businessType: co[0]?.businessType ?? "OTHER" },
  });
}

export async function DELETE() {
  await destroySession();
  return json({ ok: true });
}
