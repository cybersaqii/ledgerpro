import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requireCompany, db, defaultBranchId } from "@/lib/route-helpers";
import { convertSalesDoc, createSalesReturn } from "@/lib/doc-actions";
import { logAudit } from "@/lib/audit";

// POST /api/sales/[id]/convert — quotation/order -> posted invoice (copies lines, links source)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action === "return" ? "return" : "convert";
  const priceOverride = body.priceOverride === true;
  const applyAdvance = body.applyAdvance !== false;

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      const args = { companyId, branchId, sourceId: id, userId: session.uid, priceOverride, applyAdvance };
      if (action === "return") return createSalesReturn(tx, args);
      return convertSalesDoc(tx, args);
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: action === "return" ? "sale.return.created" : "sale.converted",
      entity: "sale", entityId: result.docId,
      detail: action === "return" ? `Sales return ${result.docNo} created` : `Invoice ${result.docNo} converted`,
    });
    if (action === "convert" && (result.advanceApplied ?? 0n) > 0n) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.advance_applied",
        entity: "sale", entityId: result.docId,
        detail: `Advance auto-applied on conversion to ${result.docNo}`,
      });
    }
    if (action === "convert" && priceOverride) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.price_override",
        entity: "sale", entityId: result.docId,
        detail: `Converted below minimum price (invoice ${result.docNo})`,
      });
    }
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Could not process the document.", 422);
  }
}
