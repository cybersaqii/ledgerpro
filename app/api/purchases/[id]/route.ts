import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { purchaseDocs, purchaseDocItems } from "@/db/schema";
import { purchaseDocSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { getPurchaseDocDetail } from "@/lib/doc-detail";
import { periodLockError } from "@/lib/period";
import { updateDraftPurchaseDoc } from "@/lib/draft-docs";
import { logAudit } from "@/lib/audit";
import type { Permission } from "@/lib/permissions";

/** Purchase orders are governed by the documents permission; bills/returns by purchases. */
function permForDocType(docType: string | null | undefined): Permission {
  return docType === "PURCHASE_ORDER" ? "documents" : "purchases";
}

async function find(companyId: string, id: string) {
  return getPurchaseDocDetail(db, companyId, id);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404);
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  return json({ data: doc });
}

// PUT — edit a DRAFT document (Phase 3: edit-from-detail). Posted documents
// cannot be edited — editing one means reverse + repost, which needs a user
// decision. Foreign-currency drafts cannot be edited yet (stored lines are
// PKR; see lib/draft-docs.ts).
export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = purchaseDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404);
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  try {
    const result = await updateDraftPurchaseDoc(db, companyId, id, parsed.data);
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `purchase.${doc.docType.toLowerCase()}.draft_updated`,
      entity: "purchase", entityId: id,
      detail: `Draft ${doc.docNo} updated`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases/[id]", companyId });
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404);
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  if (doc.status !== "DRAFT") {
    return err("Posted documents cannot be deleted. Create a return to reverse them.", 400, "DOC_LOCKED");
  }
  const lockErr = await periodLockError(db, companyId, doc.date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(purchaseDocs).where(and(eq(purchaseDocs.id, id), eq(purchaseDocs.companyId, companyId))).returning({ id: purchaseDocs.id });
    if (deleted.length > 0) {
      await tx.delete(purchaseDocItems).where(eq(purchaseDocItems.docId, id));
    }
  });
  return json({ ok: true });
}
