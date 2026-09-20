import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { salesDocs, salesDocItems, parties, journalEntries } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";

async function find(companyId: string, id: string) {
  const docs = await db
    .select({ doc: salesDocs, partyName: parties.name, partyPhone: parties.phone })
    .from(salesDocs)
    .leftJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(eq(salesDocs.id, id), eq(salesDocs.companyId, companyId)))
    .limit(1);
  const row = docs[0];
  if (!row) return null;
  const items = await db.select().from(salesDocItems).where(eq(salesDocItems.docId, id));
  let journal: unknown = null;
  if (row.doc.journalEntryId) {
    const je = await db
      .select()
      .from(journalEntries)
      .where(eq(journalEntries.id, row.doc.journalEntryId))
      .limit(1);
    journal = je[0] ?? null;
  }
  return { ...row.doc, partyName: row.partyName, partyPhone: row.partyPhone, items, journal };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404);
  return json({ data: doc });
}

// DELETE — only DRAFT documents (quotations, orders, challans) can be deleted.
// Posted invoices/returns are permanent; use a return document to reverse them.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const doc = await find(companyId, id);
  if (!doc) return err("Not found.", 404);
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
