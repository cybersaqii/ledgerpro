import { json } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requireCompany, requireOwner } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { isSampleLoaded, loadSampleData, removeSampleData } from "@/lib/sample-data";

// GET /api/sample-data — is demo data currently loaded? (any signed-in member)
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  try {
    return json({ data: { loaded: await isSampleLoaded(db, gate.companyId) } });
  } catch (e) {
    return toApiError(e, { route: "/api/sample-data", companyId: gate.companyId });
  }
}

// POST /api/sample-data — load the demo dataset (owner-only).
export async function POST() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  try {
    const r = await loadSampleData(db, { companyId, userId: session.uid, userName: session.name });
    return json({ data: { ...r, loaded: true } });
  } catch (e) {
    if (e instanceof UserError) return toApiError(e, { route: "/api/sample-data", companyId });
    return toApiError(e, { route: "/api/sample-data", companyId });
  }
}

// DELETE /api/sample-data — remove exactly the demo rows (owner-only).
export async function DELETE() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  try {
    const r = await removeSampleData(db, { companyId, userId: session.uid, userName: session.name });
    return json({ data: { ...r, loaded: false } });
  } catch (e) {
    return toApiError(e, { route: "/api/sample-data", companyId });
  }
}
