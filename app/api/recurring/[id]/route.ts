import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { parseMoney } from "@/lib/money";
import {
  FREQUENCIES,
  getTemplate,
  updateRecurringTemplate,
  deleteTemplate,
  type TemplateItem,
} from "@/lib/recurring";
import { serializeTemplate } from "../route";
import { parties } from "@/db/schema";
import { eq, and } from "drizzle-orm";

type Params = { params: Promise<{ id: string }> };

async function partyName(companyId: string, partyId: string): Promise<string> {
  const rows = await db
    .select({ name: parties.name })
    .from(parties)
    .where(and(eq(parties.id, partyId), eq(parties.companyId, companyId)))
    .limit(1);
  return rows[0]?.name ?? "";
}

// GET /api/recurring/[id] — one template. Permission: sales.
export async function GET(_req: NextRequest, { params }: Params) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { id } = await params;
  try {
    const t = await getTemplate(db, gate.companyId, id);
    if (!t) return err("Recurring template not found.", 404, "NOT_FOUND");
    return json({ data: serializeTemplate(t, await partyName(gate.companyId, t.partyId)) });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring/[id]" });
  }
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  frequency: z.enum(FREQUENCIES).optional(),
  partyId: z.string().min(1).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  terms: z.string().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  items: z
    .array(
      z.object({
        productId: z.string().min(1),
        qty: z.number().int().positive().max(1_000_000),
        rate: z.string().min(1).max(30),
      })
    )
    .min(1)
    .max(100)
    .optional(),
});

// PUT /api/recurring/[id] — edit a template (not when COMPLETED). Permission: sales.
export async function PUT(req: NextRequest, { params }: Params) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const body = await req.json().catch(() => null);
    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) return err("Please check the template and try again.", 422, "VALIDATION_ERROR");
    const b = parsed.data;
    const items: TemplateItem[] | undefined = b.items?.map((i) => ({
      productId: i.productId,
      qty: i.qty,
      ratePaisa: parseMoney(i.rate).toString(),
    }));
    await db.transaction((tx) =>
      updateRecurringTemplate(tx, companyId, id, {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.frequency !== undefined ? { frequency: b.frequency } : {}),
        ...(b.partyId !== undefined ? { partyId: b.partyId } : {}),
        ...(b.endDate !== undefined ? { endDateMs: b.endDate ? parseDateOnly(b.endDate).getTime() : null } : {}),
        ...(b.terms !== undefined ? { terms: b.terms || null } : {}),
        ...(b.notes !== undefined ? { notes: b.notes || null } : {}),
        ...(items ? { items } : {}),
      })
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "recurring.updated",
      entity: "recurring_template",
      entityId: id,
      detail: "Recurring template updated",
    });
    const t = await getTemplate(db, companyId, id);
    return json({ data: serializeTemplate(t!, await partyName(companyId, t!.partyId)) });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring/[id]" });
  }
}

// DELETE /api/recurring/[id] — delete a template and its run history. Permission: sales.
export async function DELETE(_req: NextRequest, { params }: Params) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  try {
    const t = await getTemplate(db, companyId, id);
    if (!t) return err("Recurring template not found.", 404, "NOT_FOUND");
    await db.transaction((tx) => deleteTemplate(tx, companyId, id));
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "recurring.deleted",
      entity: "recurring_template",
      entityId: id,
      detail: `Recurring template "${t.name}" deleted`,
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring/[id]" });
  }
}
