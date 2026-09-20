import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireOwner, db } from "@/lib/route-helpers";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// POST /api/users/[id]/reset-password — owner sets a new password for a staff member.
// The staff member is logged out everywhere and should change it after logging in.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  if (id === session.uid) return err("Use Change password in Settings → Security for your own account.", 422);

  const [target] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, id), eq(users.companyId, companyId)))
    .limit(1);
  if (!target) return err("User not found.", 404);

  const body = await req.json().catch(() => null);
  const password = String(body?.password || "");
  if (password.length < 8) return err("Password must be at least 8 characters.", 422);

  await db
    .update(users)
    .set({
      passwordHash: await hashPassword(password),
      tokenVersion: sql`${users.tokenVersion} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(users.id, id));

  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "user.password_reset", entity: "user", entityId: id,
    detail: `Password reset for ${target.name} <${target.email}>`,
  });
  return json({ ok: true });
}
