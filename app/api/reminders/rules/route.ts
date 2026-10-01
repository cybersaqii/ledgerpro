import { NextRequest } from "next/server";
import { z } from "zod";
import { reminderRules } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError, UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import {
  ensureDefaultReminderRules,
  isReminderKind,
  isReminderChannel,
} from "@/lib/reminders";

// GET /api/reminders/rules — list (seeds the 4 defaults on first read)
export async function GET() {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const rules = await ensureDefaultReminderRules(db, gate.companyId);
    return json({ data: rules });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/rules", companyId: gate.companyId });
  }
}

const ruleSchema = z.object({
  name: z.string().trim().min(2).max(80),
  ruleKind: z.string().refine(isReminderKind, "Invalid rule kind"),
  daysOffset: z.number().int().min(-60).max(365),
  channel: z.string().refine(isReminderChannel, "Invalid channel"),
  template: z.string().trim().max(2000).optional().or(z.literal("")),
  enabled: z.boolean().default(true),
});

// POST /api/reminders/rules — create a custom rule
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const parsed = ruleSchema.safeParse(await req.json());
    if (!parsed.success) throw new UserError("Invalid rule data.", 422, "INVALID_RULE");
    const b = parsed.data;
    const [row] = await db
      .insert(reminderRules)
      .values({
        id: crypto.randomUUID(),
        companyId: gate.companyId,
        name: b.name,
        ruleKind: b.ruleKind,
        daysOffset: b.daysOffset,
        channel: b.channel,
        template: b.template || null,
        enabled: b.enabled,
      })
      .returning({ id: reminderRules.id });
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "reminder.rule.created",
      entity: "reminder_rule",
      entityId: row.id,
      detail: b.name,
      ip: clientIp(req),
    });
    return json({ data: { id: row.id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/rules", companyId: gate.companyId });
  }
}
