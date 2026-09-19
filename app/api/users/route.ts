import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { users } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireOwner, db } from "@/lib/route-helpers";
import { hashPassword } from "@/lib/auth";
import { logAudit } from "@/lib/audit";

// GET /api/users — list company users (owner only)
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const rows = await db
    .select({ id: users.id, name: users.name, email: users.email, role: users.role, isActive: users.isActive, lastLoginAt: users.lastLoginAt })
    .from(users)
    .where(eq(users.companyId, companyId));
  return json({ data: rows });
}

// POST /api/users — add a staff member (owner only)
export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (name.length < 2) return err("Enter the staff member's name.", 422);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return err("Enter a valid email address.", 422);
  if (password.length < 8) return err("Password must be at least 8 characters.", 422);

  const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing[0]) return err("This email is already registered.", 409);

  const userId = crypto.randomUUID();
  await db.insert(users).values({
    id: userId,
    companyId,
    name,
    email,
    passwordHash: await hashPassword(password),
    role: "STAFF",
    isActive: true,
  });
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "user.invited", entity: "user", entityId: userId,
    detail: `Staff member ${name} <${email}> added`,
  });
  return json({ data: { id: userId } }, { status: 201 });
}
