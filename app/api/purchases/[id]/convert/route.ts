import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db, defaultBranchId } from "@/lib/route-helpers";
import { convertPurchaseDoc, createPurchaseReturn } from "@/lib/doc-actions";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";

const returnLineSchema = z.object({
  itemId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

// POST /api/purchases/[id]/convert — order -> posted bill, or bill -> return (debit note)
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action === "return" ? "return" : "convert";
  let returnLines: { itemId: string; qty: bigint }[] | undefined;
  if (action === "return" && Array.isArray(body.lines)) {
    const parsed = returnLineSchema.array().max(200).safeParse(body.lines);
    if (!parsed.success) return err("Invalid return quantities.", 422);
    returnLines = parsed.data.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty) }));
  }

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      const args = { companyId, branchId, sourceId: id, userId: session.uid, lines: returnLines };
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
    return toApiError(e, { route: "/api/purchases/[id]/convert", companyId });
  }
}
