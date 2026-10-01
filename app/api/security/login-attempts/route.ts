import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireOwner, db } from "@/lib/route-helpers";
import { listLoginAttempts } from "@/lib/security";

// GET /api/security/login-attempts — recent login attempts (successes and
// failures) for this company, newest first. Owner-only.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  try {
    const rows = await listLoginAttempts(db, gate.companyId, 50);
    return json({
      data: rows.map((r) => ({
        id: r.id,
        email: r.email,
        ip: r.ip,
        result: r.result,
        reason: r.reason,
        createdAt: r.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/security/login-attempts" });
  }
}
