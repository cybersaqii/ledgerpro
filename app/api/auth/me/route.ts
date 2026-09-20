import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies } from "@/db/schema";
import { getSession, destroySession } from "@/lib/auth";
import { json, err } from "@/lib/api";
import { getUserPermissions, PERMISSIONS } from "@/lib/permissions";

export async function GET() {
  const session = await getSession();
  if (!session) return err("Not signed in.", 401);
  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("Session expired.", 401);
  const co = await db
    .select({ name: companies.name, businessType: companies.businessType })
    .from(companies)
    .where(eq(companies.id, user.companyId))
    .limit(1);
  const permissions = user.role === "OWNER" ? [...PERMISSIONS] : await getUserPermissions(db, user.id);
  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role, permissions },
    company: { id: user.companyId, name: co[0]?.name ?? "", businessType: co[0]?.businessType ?? "OTHER" },
  });
}

export async function DELETE() {
  await destroySession();
  return json({ ok: true });
}
