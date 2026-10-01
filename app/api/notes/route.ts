import { NextRequest } from "next/server";
import { and, desc, eq, gte, lt } from "drizzle-orm";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requireCompany, requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseMoney } from "@/lib/money";
import { postNote, type NoteKind } from "@/lib/notes";
import { parties, accounts, notes } from "@/db/schema";

import type { Permission } from "@/lib/permissions";

const NOTE_DOC_TYPE: Record<NoteKind, string> = { CREDIT: "CREDIT_NOTE", DEBIT: "DEBIT_NOTE" };

function permForKind(kind: NoteKind): Permission {
  return kind === "CREDIT" ? "sales" : "purchases";
}

const amountRe = /^-?\d{1,12}(\.\d{1,2})?$/;

// GET /api/notes?kind=CREDIT|DEBIT&partyId=&sourceDocId=&from=&to=
// Non-item credit/debit note list. sourceDocId= shows the notes linked to
// one invoice/bill (used by the document screen's history card).
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const kindParam = sp.get("kind");
  const kind: NoteKind | null = kindParam === "CREDIT" ? "CREDIT" : kindParam === "DEBIT" ? "DEBIT" : null;

  const gate = kind ? await requirePermission(permForKind(kind)) : await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const conds = [eq(notes.companyId, companyId)];
  if (kind) conds.push(eq(notes.kind, NOTE_DOC_TYPE[kind]));
  const partyId = sp.get("partyId");
  if (partyId) conds.push(eq(notes.partyId, partyId));
  const sourceDocId = sp.get("sourceDocId");
  if (sourceDocId) conds.push(eq(notes.sourceDocId, sourceDocId));
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    const t = Date.parse(`${from}T00:00:00Z`);
    if (!isNaN(t)) conds.push(gte(notes.date, new Date(t)));
  }
  if (to) {
    const t = Date.parse(`${to}T00:00:00Z`);
    if (!isNaN(t)) conds.push(lt(notes.date, new Date(t + 86400000)));
  }

  const rows = await db
    .select({
      id: notes.id,
      kind: notes.kind,
      docNo: notes.docNo,
      date: notes.date,
      amount: notes.amount,
      notes: notes.notes,
      partyId: notes.partyId,
      partyName: parties.name,
      accountName: accounts.name,
      sourceDocId: notes.sourceDocId,
    })
    .from(notes)
    .leftJoin(parties, eq(notes.partyId, parties.id))
    .leftJoin(accounts, eq(notes.accountId, accounts.id))
    .where(and(...conds))
    .orderBy(desc(notes.date), desc(notes.createdAt))
    .limit(200);
  return json({
    data: rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      docNo: r.docNo,
      date: r.date instanceof Date ? r.date.getTime() : Number(r.date),
      amount: String(r.amount ?? "0"),
      notes: r.notes,
      partyId: r.partyId,
      partyName: r.partyName,
      accountName: r.accountName,
      sourceDocId: r.sourceDocId,
    })),
  });
}

const noteSchema = z.object({
  kind: z.enum(["CREDIT", "DEBIT"]),
  partyId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.string().regex(amountRe),
  accountId: z.string().min(1).optional(),
  sourceDocId: z.string().min(1).optional().or(z.literal("")),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  branchId: z.string().min(1).optional(),
});

// POST /api/notes — create a credit/debit note (balanced journal, party
// balance updated, period-locked, permission-gated, audit-logged).
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = noteSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;
  const kind: NoteKind = b.kind;

  const gate = await requirePermission(permForKind(kind));
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch {
    return err("Date is invalid.", 422);
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postNote(tx, {
        companyId,
        branchId,
        kind,
        partyId: b.partyId,
        date,
        amount,
        accountId: b.accountId,
        sourceDocId: b.sourceDocId || null,
        notes: b.notes || null,
        createdById: session.uid,
      });
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: kind === "CREDIT" ? "note.credit_created" : "note.debit_created",
      entity: "note", entityId: result.id,
      detail: `${kind === "CREDIT" ? "Credit note" : "Debit note"} ${result.docNo} posted`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/notes", companyId });
  }
}
