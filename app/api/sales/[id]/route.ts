import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { salesDocs, salesDocItems } from "@/db/schema";
import { salesDocSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { getSalesDocDetail } from "@/lib/doc-detail";
import { periodLockError } from "@/lib/period";
import { updateDraftSalesDoc } from "@/lib/draft-docs";
import { logAudit } from "@/lib/audit";
import type { Permission } from "@/lib/permissions";

/** Quotations are governed by the documents permission; invoices/returns by sales. */
function permForDocType(docType: string | null | undefined): Permission {
  return docType === "QUOTATION" ? "documents" : "sales";
}

async function find(companyId: string, id: string) {
  return getSalesDocDetail(db, companyId, id);
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404, "NOT_FOUND");
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
  const parsed = salesDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404, "NOT_FOUND");
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  try {
    const result = await updateDraftSalesDoc(db, companyId, id, parsed.data);
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `sale.${doc.docType.toLowerCase()}.draft_updated`,
      entity: "sale", entityId: id,
      detail: `Draft ${doc.docNo} updated`,
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]", companyId });
  }
}

// DELETE — only DRAFT documents (quotations, orders, challans) can be deleted.
// Posted invoices/returns are permanent; use a return document to reverse them.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404, "NOT_FOUND");
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  if (doc.status !== "DRAFT") {
    return err("Posted documents cannot be deleted. Create a return to reverse them.", 400, "DOC_LOCKED");
  }
  const lockErr = await periodLockError(db, companyId, doc.date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");
  await db.transaction(async (tx) => {
    const deleted = await tx.delete(salesDocs).where(and(eq(salesDocs.id, id), eq(salesDocs.companyId, companyId))).returning({ id: salesDocs.id });
    if (deleted.length > 0) {
      await tx.delete(salesDocItems).where(eq(salesDocItems.docId, id));
    }
  });
  return json({ ok: true });
}
