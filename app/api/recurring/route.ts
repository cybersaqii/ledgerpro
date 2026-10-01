import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { parseMoney } from "@/lib/money";
import {
  FREQUENCIES,
  createRecurringTemplate,
  listTemplates,
  type TemplateItem,
} from "@/lib/recurring";

// GET /api/recurring — list templates (newest first) with party names.
// POST /api/recurring — create a template. Permission: sales.
export async function GET() {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  try {
    const rows = await listTemplates(db, gate.companyId);
    return json({
      data: rows.map((r) => serializeTemplate(r.template, r.partyName)),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring" });
  }
}

const itemSchema = z.object({
  productId: z.string().min(1),
  qty: z.number().int().positive().max(1_000_000),
  rate: z.string().min(1).max(30), // decimal rupees, converted server-side
});

const templateSchema = z.object({
  branchId: z.string().min(1).optional(),
  partyId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  frequency: z.enum(FREQUENCIES),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD"),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD").nullable().optional(),
  terms: z.string().trim().max(500).optional().or(z.literal("")),
  notes: z.string().trim().max(1000).optional().or(z.literal("")),
  items: z.array(itemSchema).min(1).max(100),
});

export async function POST(req: NextRequest) {
  const gate = await requirePermission("sales");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const parsed = templateSchema.safeParse(body);
    if (!parsed.success) return err("Please check the template and try again.", 422, "VALIDATION_ERROR");
    const b = parsed.data;
    const startMs = parseDateOnly(b.startDate).getTime();
    const endMs = b.endDate ? parseDateOnly(b.endDate).getTime() : null;
    const items: TemplateItem[] = b.items.map((i) => ({
      productId: i.productId,
      qty: i.qty,
      ratePaisa: parseMoney(i.rate).toString(),
    }));
    const id = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return createRecurringTemplate(
        tx,
        companyId,
        {
          branchId,
          partyId: b.partyId,
          name: b.name,
          frequency: b.frequency,
          startDateMs: startMs,
          endDateMs: endMs,
          terms: b.terms || null,
          notes: b.notes || null,
          items,
        },
        session.uid
      );
    });
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "recurring.created",
      entity: "recurring_template",
      entityId: id,
      detail: `Recurring template "${b.name}" (${b.frequency}) created`,
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/recurring" });
  }
}

export function serializeTemplate(
  t: {
    id: string;
    branchId: string;
    partyId: string;
    name: string;
    frequency: string;
    startDate: Date;
    endDate: Date | null;
    nextRunDate: Date;
    status: string;
    terms: string | null;
    notes: string | null;
    itemsJson: string;
    skipNext: boolean;
    lastRunAt: Date | null;
    createdAt: Date;
  },
  partyName: string
) {
  return {
    id: t.id,
    branchId: t.branchId,
    partyId: t.partyId,
    partyName,
    name: t.name,
    frequency: t.frequency,
    startDate: t.startDate.toISOString(),
    endDate: t.endDate?.toISOString() ?? null,
    nextRunDate: t.nextRunDate.toISOString(),
    status: t.status,
    terms: t.terms,
    notes: t.notes,
    items: JSON.parse(t.itemsJson) as TemplateItem[],
    skipNext: t.skipNext,
    lastRunAt: t.lastRunAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
  };
}
