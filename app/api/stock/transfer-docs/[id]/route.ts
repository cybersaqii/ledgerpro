import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { issueStockTransfer, receiveStockTransfer, cancelStockTransfer } from "@/lib/inventory";
import { docWithLines } from "../route";

const actionSchema = z.object({
  action: z.enum(["issue", "receive", "cancel"]),
});

// GET /api/stock/transfer-docs/[id] — one transfer document with lines.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const doc = await docWithLines(companyId, id);
  if (!doc) return err("Not found.", 404, "NOT_FOUND");
  return json({ data: doc });
}

// PATCH /api/stock/transfer-docs/[id] — { action: "issue" | "receive" | "cancel" }.
//   issue:   DRAFT -> IN_TRANSIT (deducts source branch at its average cost)
//   receive: IN_TRANSIT -> RECEIVED (adds destination branch at captured cost)
//   cancel:  DRAFT/IN_TRANSIT -> CANCELLED (in-transit stock returns to source)
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = actionSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");

  try {
    const result = await db.transaction((tx) => {
      if (parsed.data.action === "issue") return issueStockTransfer(tx, companyId, id);
      if (parsed.data.action === "receive") return receiveStockTransfer(tx, companyId, id);
      return cancelStockTransfer(tx, companyId, id);
    });
    const verbs = { issue: "issued", receive: "received", cancel: "cancelled" } as const;
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: `stock.transfer_${verbs[parsed.data.action]}`,
      entity: "stock_transfer",
      entityId: id,
      detail: `Transfer ${result.docNo} ${verbs[parsed.data.action]}`,
    });
    return json({ data: await docWithLines(companyId, id) });
  } catch (e) {
    return toApiError(e, { route: "/api/stock/transfer-docs/[id]", companyId });
  }
}
