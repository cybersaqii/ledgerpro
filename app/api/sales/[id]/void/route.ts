import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { voidSalesInvoice } from "@/lib/sales-void";
import { logAudit } from "@/lib/audit";

// POST /api/sales/[id]/void — void a posted sales invoice. Never deletes:
// posts an exact reversing journal, releases receipt allocations (the money
// stays as customer advance credit), restores stock + batch lineage, and
// stamps the invoice VOID.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const perm = await requirePermission("sales");
  if (!perm.ok) return perm.response;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const reason = z.string().trim().max(200).safeParse(body.reason);
  if (!reason.success) return err("Reason is too long.", 422);

  try {
    const result = await db.transaction((tx) =>
      voidSalesInvoice(tx, {
        companyId,
        invoiceId: id,
        reason: reason.data || undefined,
        userId: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "sale.voided",
      entity: "sale", entityId: id,
      detail: `Sales invoice voided${reason.data ? ` — ${reason.data}` : ""}`,
    });
    return json({ data: result }, { status: 200 });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/void", companyId });
  }
}
