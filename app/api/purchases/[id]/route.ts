import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { purchaseDocs, purchaseDocItems, parties } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import type { Permission } from "@/lib/permissions";

/** Purchase orders are governed by the documents permission; bills/returns by purchases. */
function permForDocType(docType: string | null | undefined): Permission {
  return docType === "PURCHASE_ORDER" ? "documents" : "purchases";
}

async function find(companyId: string, id: string) {
  const docs = await db
    .select({ doc: purchaseDocs, partyName: parties.name })
    .from(purchaseDocs)
    .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(eq(purchaseDocs.id, id), eq(purchaseDocs.companyId, companyId)))
    .limit(1);
  const row = docs[0];
  if (!row) return null;
  const items = await db.select().from(purchaseDocItems).where(eq(purchaseDocItems.docId, id));
  return { ...row.doc, partyName: row.partyName, items };
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
    await tx.delete(purchaseDocItems).where(eq(purchaseDocItems.docId, id));
    await tx.delete(purchaseDocs).where(eq(purchaseDocs.id, id));
  });
  return json({ ok: true });
}
