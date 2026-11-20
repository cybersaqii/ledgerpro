import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { purchaseDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { postDraftPurchaseDoc } from "@/lib/draft-docs";
import { logAudit } from "@/lib/audit";

// POST /api/purchases/[id]/post — post a DRAFT bill/return (Phase 3:
// save-as-draft lifecycle). Replays the stored rows through the posting
// engine. Draft bills never carry landed extra costs (rejected at
// create/edit), so there is nothing to replay for them.
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;
  const [doc] = await db
    .select({ docType: purchaseDocs.docType, docNo: purchaseDocs.docNo })
    .from(purchaseDocs)
    .where(and(eq(purchaseDocs.id, id), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  if (!doc) return err("Not found.", 404);
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  try {
    const result = await db.transaction((tx) =>
      postDraftPurchaseDoc(tx, companyId, id, session.uid)
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `purchase.${doc.docType.toLowerCase()}.posted`,
      entity: "purchase", entityId: id,
      detail: `Draft ${doc.docNo} posted`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases/[id]/post", companyId });
  }
}
