import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { salesDocs, salesDocItems } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { getSalesDocDetail } from "@/lib/doc-detail";
import { periodLockError } from "@/lib/period";
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
  if (!doc) return err("Not found.", 404);
  const gate = await requirePermission(permForDocType(doc.docType));
  if (!gate.ok) return gate.response;
  return json({ data: doc });
}

// DELETE — only DRAFT documents (quotations, orders, challans) can be deleted.
// Posted invoices/returns are permanent; use a return document to reverse them.
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
    return err("Posted documents cannot be deleted. Create a return to reverse them.", 400);
  }
  const lockErr = await periodLockError(db, companyId, doc.date);
  if (lockErr) return err(lockErr, 422);
  await db.transaction(async (tx) => {
    await tx.delete(salesDocItems).where(eq(salesDocItems.docId, id));
    await tx.delete(salesDocs).where(eq(salesDocs.id, id));
  });
  return json({ ok: true });
}
