import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requireCompany, db, defaultBranchId } from "@/lib/route-helpers";
import { convertSalesDoc, createSalesReturn } from "@/lib/doc-actions";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";

const returnLineSchema = z.object({
  itemId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

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
  // partial return: per-item quantities; omitted = full return of what remains
  let returnLines: { itemId: string; qty: bigint }[] | undefined;
  if (action === "return" && Array.isArray(body.lines)) {
    const parsed = returnLineSchema.array().max(200).safeParse(body.lines);
    if (!parsed.success) return err("Invalid return quantities.", 422);
    returnLines = parsed.data.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty) }));
  }

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      const args = { companyId, branchId, sourceId: id, userId: session.uid, priceOverride, applyAdvance, lines: returnLines };
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
