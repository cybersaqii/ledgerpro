import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany } from "@/lib/route-helpers";

/** GET /api/auth/mfa/status — returns whether MFA is enabled for the current user. */
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;

  const rows = await db
    .select({ mfaEnabled: users.mfaEnabled, mfaEnrolledAt: users.mfaEnrolledAt })
    .from(users)
    .where(eq(users.id, gate.session.uid))
    .limit(1);
  const user = rows[0];
  return json({
    ok: true,
    mfaEnabled: !!user?.mfaEnabled,
    enrolledAt: user?.mfaEnrolledAt ?? null,
  });
}
