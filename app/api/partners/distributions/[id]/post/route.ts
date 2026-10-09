import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { postDistribution } from "@/lib/partners";
import { logAudit } from "@/lib/audit";

// POST /api/partners/distributions/[id]/post — DRAFT → POSTED
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;

  try {
    const entryId = await db.transaction(async (tx) => {
      return postDistribution(tx, companyId, id, session.uid);
    });
    await logAudit(db, {
      companyId,
      userId: session.uid, userName: session.name,
      action: "partner.distribution.post",
      entity: "profit_distribution",
      entityId: id,
      detail: "Distribution posted",
    });
    return json({ data: { journalEntryId: entryId } });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}
