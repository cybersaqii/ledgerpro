import { NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { reminderLog, reminderRules, salesDocs } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";

// GET /api/reminders/log — dispatch history (newest first, company-scoped)
export async function GET(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const limit = Math.min(Math.max(parseInt(req.nextUrl.searchParams.get("limit") ?? "50", 10) || 50, 1), 200);
    const rows = await db
      .select({
        id: reminderLog.id,
        triggerDate: reminderLog.triggerDate,
        status: reminderLog.status,
        detail: reminderLog.detail,
        emailSent: reminderLog.emailSent,
        emailSkipped: reminderLog.emailSkipped,
        whatsappQueued: reminderLog.whatsappQueued,
        createdAt: reminderLog.createdAt,
        docNo: salesDocs.docNo,
        ruleName: reminderRules.name,
        ruleKind: reminderRules.ruleKind,
        daysOffset: reminderRules.daysOffset,
      })
      .from(reminderLog)
      .leftJoin(salesDocs, eq(salesDocs.id, reminderLog.invoiceId))
      .leftJoin(reminderRules, eq(reminderRules.id, reminderLog.ruleId))
      .where(eq(reminderLog.companyId, gate.companyId))
      .orderBy(desc(reminderLog.createdAt))
      .limit(limit);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/log", companyId: gate.companyId });
  }
}
