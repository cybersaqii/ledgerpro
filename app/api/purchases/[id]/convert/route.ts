import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requireCompany, db, defaultBranchId } from "@/lib/route-helpers";
import { convertPurchaseDoc, createPurchaseReturn } from "@/lib/doc-actions";
import { logAudit } from "@/lib/audit";

// POST /api/purchases/[id]/convert — order -> posted bill, or bill -> return (debit note)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action === "return" ? "return" : "convert";

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      const args = { companyId, branchId, sourceId: id, userId: session.uid };
      if (action === "return") return createPurchaseReturn(tx, args);
      return convertPurchaseDoc(tx, args);
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: action === "return" ? "purchase.return.created" : "purchase.converted",
      entity: "purchase", entityId: result.docId,
      detail: action === "return" ? `Purchase return ${result.docNo} created` : `Bill ${result.docNo} converted`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Could not process the document.", 422);
  }
}
