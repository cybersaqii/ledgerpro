// Module 13 — Projects & Job Costing API.
//
// GET  /api/projects?status=ACTIVE        — project list (read-only master
//                                            data: requireCompany only, so the
//                                            doc-form picker can load it).
// POST /api/projects                      — create (projects permission,
//                                            idempotent via PRJ- sequence).
import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission } from "@/lib/route-helpers";
import { createProject, listProjects, PROJECT_STATUSES, type ProjectStatus } from "@/lib/projects";
import { logAudit } from "@/lib/audit";

const createSchema = z.object({
  name: z.string().trim().min(1, "Project name is required.").max(120),
  customerId: z.string().min(1).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  contractValue: z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid amount").default("0"),
  budget: z.string().regex(/^\d+(\.\d{1,2})?$/, "Invalid amount").default("0"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

function rupeesToPaisa(s: string): bigint {
  const [r = "0", p = ""] = s.split(".");
  return BigInt(r) * 100n + BigInt((p + "00").slice(0, 2));
}

// GET /api/projects?status=
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  try {
    const sp = req.nextUrl.searchParams;
    const statusRaw = sp.get("status");
    const status = statusRaw ? (statusRaw.toUpperCase() as ProjectStatus) : undefined;
    if (status && !PROJECT_STATUSES.includes(status)) return err("Unknown project status.", 422, "PROJECT_BAD_STATUS");
    const rows = await listProjects(db, companyId, status);
    return json({
      projects: rows.map((p) => ({
        id: p.id,
        code: p.code,
        name: p.name,
        customerId: p.customerId,
        customerName: p.customerName,
        startDate: p.startDate,
        endDate: p.endDate,
        contractValue: p.contractValue.toString(),
        budget: p.budget.toString(),
        status: p.status,
        notes: p.notes,
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/projects", companyId });
  }
}

// POST /api/projects — idempotent: the PRJ- sequence is consumed inside the
// transaction, so a retried request creates a new project (codes must stay
// unique); callers should not retry blindly on network errors.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("projects");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid project.", 422);

  try {
    const project = await db.transaction((tx) =>
      createProject(tx, {
        companyId,
        name: b.data.name,
        customerId: b.data.customerId || null,
        startDate: b.data.startDate ? new Date(b.data.startDate + "T00:00:00Z") : null,
        endDate: b.data.endDate ? new Date(b.data.endDate + "T00:00:00Z") : null,
        contractValuePaisa: rupeesToPaisa(b.data.contractValue),
        budgetPaisa: rupeesToPaisa(b.data.budget),
        notes: b.data.notes || null,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "project.created", entity: "project", entityId: project.id,
      detail: `Project ${project.code} — ${project.name}`,
    });
    return json(
      {
        id: project.id,
        code: project.code,
        name: project.name,
        status: project.status,
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/projects", companyId });
  }
}
