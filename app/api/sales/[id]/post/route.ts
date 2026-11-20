import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { salesDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { postDraftSalesDoc } from "@/lib/draft-docs";
import { logAudit } from "@/lib/audit";
import { CreditLimitError } from "@/lib/credit-limit";
import { CreditHoldError } from "@/lib/credit-control";

// POST /api/sales/[id]/post — post a DRAFT invoice/return (Phase 3:
// save-as-draft lifecycle). Replays the stored rows through the posting
// engine; credit-limit / credit-hold / min-price checks run here, with the
// same override confirmations as creating a posted invoice.
// Body: { overrideCreditLimit?, overrideCreditHold?, priceOverride? }
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const [doc] = await db
    .select({ docType: salesDocs.docType, docNo: salesDocs.docNo })
    .from(salesDocs)
    .where(and(eq(salesDocs.id, id), eq(salesDocs.companyId, companyId)))
    .limit(1);
  if (!doc) return err("Not found.", 404, "NOT_FOUND");
  const gate = await requirePermission(doc.docType === "QUOTATION" ? "documents" : "sales");
  if (!gate.ok) return gate.response;
  try {
    const result = await db.transaction((tx) =>
      postDraftSalesDoc(tx, companyId, id, session.uid, {
        overrideCreditLimit: body?.overrideCreditLimit === true,
        overrideCreditHold: body?.overrideCreditHold === true,
        priceOverride: body?.priceOverride === true,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `sale.${doc.docType.toLowerCase()}.posted`,
      entity: "sale", entityId: id,
      detail: `Draft ${doc.docNo} posted`,
    });
    if (body?.overrideCreditLimit === true) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.credit_limit_override",
        entity: "sale", entityId: id,
        detail: `Posted ${doc.docNo} with credit-limit override`,
      });
    }
    if (body?.overrideCreditHold === true) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.credit_hold_override",
        entity: "sale", entityId: id,
        detail: `Posted ${doc.docNo} with credit-hold override`,
      });
    }
    return json({ data: result });
  } catch (e) {
    if (e instanceof CreditLimitError)
      return json({ error: e.message, code: "CREDIT_LIMIT_EXCEEDED", details: e.details }, { status: 409 });
    if (e instanceof CreditHoldError)
      return json({ error: e.message, code: "CREDIT_ON_HOLD", details: e.details }, { status: 409 });
    return toApiError(e, { route: "/api/sales/[id]/post", companyId });
  }
}
