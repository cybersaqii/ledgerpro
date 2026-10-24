import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requireOwner, db } from "@/lib/route-helpers";
import { reconcileCachedTotals } from "@/lib/cached-totals";
import { logAudit } from "@/lib/audit";

/**
 * Cached-totals reconciliation (Phase P1, item 1) — owner-only, scoped to
 * the session company, never cross-tenant.
 *
 * GET  -> report only. Never writes, whatever the caller passes.
 * POST { applyFixes: true } -> the same report, then applies the
 * fixable discrepancies inside one transaction and returns both the
 * fixed rows and any remaining (unfixable / informational) findings.
 * Any POST without applyFixes: true is a report, not a fix.
 */
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const result = await db.transaction((tx) => reconcileCachedTotals(tx, gate.companyId));
  return json({ data: result });
}

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  let body: unknown = {};
  try {
    body = await req.json();
  } catch {
    return err("Invalid JSON body.", 400);
  }
  const applyFixes = (body as { applyFixes?: unknown }).applyFixes === true;
  const result = await db.transaction((tx) => reconcileCachedTotals(tx, gate.companyId, { applyFixes }));
  if (applyFixes && result.fixed.length > 0) {
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name,
      action: "reconciliation.fixes_applied",
      entity: "company",
      entityId: gate.companyId,
      detail: `Cached-totals reconciliation applied ${result.fixed.length} fix(es): ${result.fixed.map((f) => `${f.kind} ${f.label} ${f.stored} -> ${f.expected}`).join("; ")}`,
    });
  }
  return json({ data: result });
}
