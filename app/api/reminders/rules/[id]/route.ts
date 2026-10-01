import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { reminderRules } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError, UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { isReminderKind, isReminderChannel } from "@/lib/reminders";

// PUT /api/reminders/rules/[id] — update a rule (company-scoped)
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const { id } = await params;
    const schema = z.object({
      name: z.string().trim().min(2).max(80).optional(),
      ruleKind: z.string().refine(isReminderKind, "Invalid rule kind").optional(),
      daysOffset: z.number().int().min(-60).max(365).optional(),
      channel: z.string().refine(isReminderChannel, "Invalid channel").optional(),
      template: z.string().trim().max(2000).nullable().optional(),
      enabled: z.boolean().optional(),
    });
    const parsed = schema.safeParse(await req.json());
    if (!parsed.success) throw new UserError("Invalid rule data.", 422, "INVALID_RULE");
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(parsed.data)) {
      if (v !== undefined) patch[k] = k === "template" && v === "" ? null : v;
    }
    const updated = await db
      .update(reminderRules)
      .set(patch)
      .where(and(eq(reminderRules.id, id), eq(reminderRules.companyId, gate.companyId)))
      .returning({ id: reminderRules.id });
    if (updated.length === 0) return err("Rule not found.", 404);
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "reminder.rule.updated",
      entity: "reminder_rule",
      entityId: id,
      ip: clientIp(req),
    });
    return json({ data: { id: id } });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/rules/[id]", companyId: gate.companyId });
  }
}

// DELETE /api/reminders/rules/[id] — delete a rule (company-scoped)
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const { id } = await params;
    const deleted = await db
      .delete(reminderRules)
      .where(and(eq(reminderRules.id, id), eq(reminderRules.companyId, gate.companyId)))
      .returning({ id: reminderRules.id });
    if (deleted.length === 0) return err("Rule not found.", 404);
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "reminder.rule.deleted",
      entity: "reminder_rule",
      entityId: id,
      ip: clientIp(req),
    });
    return json({ data: { id: id } });
  } catch (e) {
    return toApiError(e, { route: "/api/reminders/rules/[id]", companyId: gate.companyId });
  }
}
