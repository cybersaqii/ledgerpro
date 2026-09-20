import { eq } from "drizzle-orm";
import { users } from "@/db/schema";
import { db } from "@/lib/db";
import { hashPassword } from "@/lib/auth";
import { generateRecoveryCode, normalizeRecoveryCode } from "@/lib/recovery";
import { requireAuth, json } from "@/lib/api";
import { logAudit } from "@/lib/audit";

// POST /api/auth/recovery-code — (re)generate the logged-in user's recovery code.
// Returns the plain code ONCE; the UI must show it for the user to save.
export async function POST() {
  const { session, response } = await requireAuth();
  if (!session) return response;
  const code = generateRecoveryCode();
  await db
    .update(users)
    .set({ recoveryCodeHash: await hashPassword(normalizeRecoveryCode(code)), updatedAt: new Date() })
    .where(eq(users.id, session.uid));
  await logAudit(db, {
    companyId: session.cid, userId: session.uid, userName: session.name,
    action: "auth.recovery_code_regenerated", entity: "user", entityId: session.uid,
    detail: "Recovery code regenerated",
  });
  return json({ ok: true, recoveryCode: code });
}
