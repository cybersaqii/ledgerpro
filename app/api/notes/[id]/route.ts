import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { requireCompany, requirePermission } from "@/lib/route-helpers";
import { db } from "@/lib/route-helpers";
import { parties, accounts, salesDocs, purchaseDocs, notes } from "@/db/schema";

import type { Permission } from "@/lib/permissions";

// GET /api/notes/[id] — one credit/debit note, shaped like a document so the
// shared document renderer prints it with its own distinct title.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId } = auth;
  const { id } = await params;

  const rows = await db
    .select({
      id: notes.id,
      kind: notes.kind,
      docNo: notes.docNo,
      date: notes.date,
      amount: notes.amount,
      noteText: notes.notes,
      partyId: notes.partyId,
      partyName: parties.name,
      partyPhone: parties.phone,
      accountName: accounts.name,
      sourceDocId: notes.sourceDocId,
      salesRef: salesDocs.docNo,
      purchRef: purchaseDocs.docNo,
    })
    .from(notes)
    .leftJoin(parties, eq(notes.partyId, parties.id))
    .leftJoin(accounts, eq(notes.accountId, accounts.id))
    .leftJoin(salesDocs, eq(notes.sourceDocId, salesDocs.id))
    .leftJoin(purchaseDocs, eq(notes.sourceDocId, purchaseDocs.id))
    .where(and(eq(notes.id, id), eq(notes.companyId, companyId)))
    .limit(1);
  if (rows.length === 0) return err("Not found.", 404);
  const n = rows[0];

  const perm: Permission = n.kind === "CREDIT_NOTE" ? "sales" : "purchases";
  const gate = await requirePermission(perm);
  if (!gate.ok) return gate.response;

  const amount = String(n.amount ?? "0");
  const sourceDocNo = n.salesRef ?? n.purchRef ?? null;
  const itemDesc = `${n.accountName ?? "Note"}${sourceDocNo ? ` — against ${sourceDocNo}` : ""}`;
  return json({
    data: {
      id: n.id,
      docNo: n.docNo,
      docType: n.kind,
      date: n.date instanceof Date ? n.date.getTime() : Number(n.date),
      dueDate: null,
      status: "POSTED",
      subtotal: amount,
      discountTotal: "0",
      taxTotal: "0",
      grandTotal: amount,
      amountPaid: "0",
      returnedTotal: "0",
      notes: n.noteText,
      terms: null,
      refNo: sourceDocNo,
      partyName: n.partyName,
      partyId: n.partyId,
      partyPhone: n.partyPhone,
      sourceDocId: n.sourceDocId,
      items: [
        {
          id: `${n.id}-line`,
          description: itemDesc,
          qty: "1000", // 1.000 base unit — amount-only line
          qtyReturned: "0",
          rate: amount,
          discount: "0",
          lineTotal: amount,
          extraCost: null,
          unit: "—",
          sku: null,
          taxBps: 0,
          taxAmount: "0",
          batches: null,
        },
      ],
      payments: [],
    },
  });
}
