import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users, branches, accounts } from "@/db/schema";
import { verifyPassword, createSession } from "@/lib/auth";
import { loginSchema } from "@/lib/validators";
import { setupCompany, SYS } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { rateLimitDb, clientIp } from "@/lib/rate-limit-db";
import { logAudit } from "@/lib/audit";

export async function POST(req: NextRequest) {
  const rl = await rateLimitDb(`login:${clientIp(req)}`, 10, 60_000);
  if (!rl.ok) {
    return json(
      { error: `Too many login attempts. Try again in ${rl.retryAfterSec} seconds.` },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );
  }
  const body = await req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const { email, password } = parsed.data;

  const rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
  const user = rows[0];
  if (!user || !user.isActive) return err("Invalid email or password.", 401);
  if (!(await verifyPassword(password, user.passwordHash))) return err("Invalid email or password.", 401);

  // Retry bootstrap if a previous signup was interrupted mid-way, or backfill
  // system accounts added after the company was created (setup is idempotent).
  const branchRows = await db
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.companyId, user.companyId))
    .limit(1);
  const codeRows = await db
    .select({ code: accounts.code })
    .from(accounts)
    .where(eq(accounts.companyId, user.companyId));
  const haveCodes = new Set(codeRows.map((r) => r.code));
  const missingCodes = Object.values(SYS).filter((c) => !haveCodes.has(c));
  if (!branchRows[0] || missingCodes.length > 0) {
    try {
      await setupCompany(db, user.companyId);
    } catch (e) {
      console.error("Bootstrap retry failed", e);
      return err("Account setup is incomplete. Please try again in a moment.", 500);
    }
  }

  await createSession({
    uid: user.id,
    cid: user.companyId,
    name: user.name,
    email: user.email,
    role: user.role,
    v: user.tokenVersion,
  });
  await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  await logAudit(db, {
    companyId: user.companyId, userId: user.id, userName: user.name,
    action: "auth.login", entity: "user", entityId: user.id,
  });
  return json({
    ok: true,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}
