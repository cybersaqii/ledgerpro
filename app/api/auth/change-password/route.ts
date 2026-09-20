import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/db";
import { hashPassword, verifyPassword, createSession } from "@/lib/auth";
import { requireAuth, json, err } from "@/lib/api";
import { logAudit } from "@/lib/audit";

// POST /api/auth/change-password — logged-in user changes their own password.
// Other sessions are logged out; the current session is re-issued.
export async function POST(req: NextRequest) {
  const { session, response } = await requireAuth();
  if (!session) return response;
  const body = await req.json().catch(() => null);
  const currentPassword = String(body?.currentPassword || "");
  const newPassword = String(body?.newPassword || "");
  if (newPassword.length < 8) return err("New password must be at least 8 characters.", 422);
  if (currentPassword === newPassword) return err("New password must be different from the current one.", 422);

  const [user] = await db.select().from(users).where(eq(users.id, session.uid)).limit(1);
  if (!user || !user.isActive) return err("Account not found.", 404);
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return err("Current password is incorrect.", 401);
  }

  const newVersion = user.tokenVersion + 1;
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(newPassword), tokenVersion: newVersion, updatedAt: new Date() })
    .where(eq(users.id, user.id));

  // Re-issue this session so the user stays logged in here; others are logged out.
  await createSession({ ...session, v: newVersion });

  await logAudit(db, {
    companyId: session.cid, userId: session.uid, userName: session.name,
    action: "auth.password_changed", entity: "user", entityId: session.uid,
    detail: "Password changed",
  });
  return json({ ok: true });
}
