import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { runPaymentReminders } from "@/lib/reminders";

// POST /api/reminders/run — run the reminder engine on demand (settings perm).
// Idempotent: re-running the same day only reports duplicates, never resends.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const baseUrl = `${req.nextUrl.protocol}//${req.nextUrl.host}`;
    const result = await runPaymentReminders(db, { companyId: gate.companyId, baseUrl });
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "reminder.run.manual",
      detail: `dispatched=${result.dispatched} duplicates=${result.duplicates} failures=${result.failures.length}`,
      ip: clientIp(req),
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/run", companyId: gate.companyId });
  }
}
