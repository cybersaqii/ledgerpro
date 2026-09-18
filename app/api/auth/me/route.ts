import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, companies } from "@/db/schema";
import { getSession, destroySession } from "@/lib/auth";
import { json, err } from "@/lib/api";

export async function GET() {
  const session = await getSession();
  if (!session) return err("Not signed in.", 401);
  const rows = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("Session expired.", 401);
  const co = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, user.companyId))
    .limit(1);
  return json({
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    company: { id: user.companyId, name: co[0]?.name ?? "" },
  });
}

export async function DELETE() {
  await destroySession();
  return json({ ok: true });
}
