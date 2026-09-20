import { db } from "@/lib/db";
import { requireAuth, json } from "@/lib/api";
import { hasRecoveryCode } from "@/lib/recovery";

// GET /api/auth/recovery-status — does the current user have a recovery code?
// Accounts created before the recovery-code feature shipped may not.
export async function GET() {
  const { session, response } = await requireAuth();
  if (!session) return response;
  return json({ hasCode: await hasRecoveryCode(db, session.uid) });
}
