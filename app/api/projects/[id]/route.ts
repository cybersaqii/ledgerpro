// Module 13 — single project.
//
// GET   /api/projects/[id]?from=&to=   — detail + job-cost P&L + tagged docs
// PATCH /api/projects/[id]              — edit fields / change status
// (both need the projects permission; margins are sensitive).
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, parseDateOnly } from "@/lib/route-helpers";
import {
  getProject,
  updateProject,
  projectPL,
  taggedDocs,
  PROJECT_STATUSES,
  type ProjectStatus,
} from "@/lib/projects";
import { parties } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { logAudit } from "@/lib/audit";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  customerId: z.string().min(1).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").nullable().optional(),
  contractValue: z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid amount").optional(),
  budget: z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid amount").optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

function rupeesToPaisa(s: string): bigint {
  const [r = "0", p = ""] = s.split(".");
  return BigInt(r) * 100n + BigInt((p + "00").slice(0, 2));
}

function serializeProject(p: Awaited<ReturnType<typeof getProject>>, customerName: string | null) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    customerId: p.customerId,
    customerName,
    startDate: p.startDate,
    endDate: p.endDate,
    contractValue: p.contractValue.toString(),
    budget: p.budget.toString(),
    status: p.status as ProjectStatus,
    notes: p.notes,
  };
}

// GET /api/projects/[id]?from=YYYY-MM-DD&to=YYYY-MM-DD
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("projects");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  try {
    const p = await getProject(db, companyId, id);
    const sp = req.nextUrl.searchParams;
    let from: Date | null = null;
    let to: Date | null = null;
    try {
      if (sp.get("from")) from = parseDateOnly(sp.get("from")!);
    } catch { /* ignore */ }
    try {
      if (sp.get("to")) {
        to = parseDateOnly(sp.get("to")!);
        to = new Date(to.getTime() + 86400000 - 1); // inclusive end of day
      }
    } catch { /* ignore */ }

    const [pl, docs] = await Promise.all([
      projectPL(db, companyId, id, from, to),
      taggedDocs(db, companyId, id),
    ]);
    let customerName: string | null = null;
    if (p.customerId) {
      const [c] = await db.select({ name: parties.name }).from(parties).where(and(eq(parties.id, p.customerId), eq(parties.companyId, companyId))).limit(1);
      customerName = c?.name ?? null;
    }
    return json({
      project: serializeProject(p, customerName),
      pl: {
        ...pl,
        revenue: pl.revenue.toString(),
        cost: pl.cost.toString(),
        profit: pl.profit.toString(),
        wip: pl.wip.toString(),
        costByAccount: pl.costByAccount.map((c) => ({ ...c, amount: c.amount.toString() })),
      },
      docs: docs.map((d) => ({ ...d, total: d.total.toString() })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/projects/[id]", companyId });
  }
}

// PATCH /api/projects/[id]
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("projects");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid project update.", 422);

  try {
    const p = await db.transaction((tx) =>
      updateProject(tx, companyId, id, {
        name: b.data.name,
        customerId: b.data.customerId === undefined ? undefined : b.data.customerId,
        startDate: b.data.startDate === undefined ? undefined : b.data.startDate ? new Date(b.data.startDate + "T00:00:00Z") : null,
        endDate: b.data.endDate === undefined ? undefined : b.data.endDate ? new Date(b.data.endDate + "T00:00:00Z") : null,
        contractValuePaisa: b.data.contractValue !== undefined ? rupeesToPaisa(b.data.contractValue) : undefined,
        budgetPaisa: b.data.budget !== undefined ? rupeesToPaisa(b.data.budget) : undefined,
        status: b.data.status,
        notes: b.data.notes === undefined ? undefined : b.data.notes,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "project.updated", entity: "project", entityId: p.id,
      detail: `Project ${p.code} updated${b.data.status ? ` (status → ${b.data.status})` : ""}`,
    });
    return json({ id: p.id, code: p.code, name: p.name, status: p.status });
  } catch (e) {
    return toApiError(e, { route: "/api/projects/[id]", companyId });
  }
}
