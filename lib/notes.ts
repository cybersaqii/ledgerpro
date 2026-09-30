import { eq, and, sql } from "drizzle-orm";
import { accounts, parties, salesDocs, purchaseDocs, numberSequences, notes } from "@/db/schema";

import { SYS, accountMap, nextDocNo } from "./setup";
import { createJournal } from "./posting";
import { UserError } from "./errors";
import type { DbTx } from "./db";

export type NoteKind = "CREDIT" | "DEBIT"; // CREDIT -> CREDIT_NOTE (sales) | DEBIT -> DEBIT_NOTE (purchase)

export type PostNoteInput = {
  companyId: string;
  branchId: string;
  kind: NoteKind;
  partyId: string;
  date: Date;
  amount: bigint; // paisa, must be positive
  accountId?: string; // ledger account carrying the amount; defaults to Discount Given/Received
  sourceDocId?: string | null; // linked invoice (CREDIT) or bill (DEBIT)
  notes?: string | null;
  createdById: string;
};

export type PostNoteResult = { id: string; docNo: string; journalEntryId: string };

const DOC_TYPE: Record<NoteKind, string> = { CREDIT: "CREDIT_NOTE", DEBIT: "DEBIT_NOTE" };
const SEQ_PREFIX: Record<NoteKind, string> = { CREDIT: "CN-", DEBIT: "DN-" };
// Default ledger account for each note kind (SYS codes from lib/setup.ts).
const DEFAULT_ACCOUNT: Record<NoteKind, keyof typeof SYS> = {
  CREDIT: "DISCOUNT_GIVEN",
  DEBIT: "DISCOUNT_RECEIVED",
};

/** Make sure the number sequence for the note kind exists with the right
 *  prefix (CN-/DN-) before nextDocNo() consumes it. Idempotent: never
 *  touches an existing row. */
async function ensureNoteSequence(tx: DbTx, companyId: string, kind: NoteKind): Promise<void> {
  await tx
    .insert(numberSequences)
    .values({
      id: crypto.randomUUID(),
      companyId,
      docType: DOC_TYPE[kind],
      prefix: SEQ_PREFIX[kind],
      lastNo: 0,
    })
    .onConflictDoNothing({ target: [numberSequences.companyId, numberSequences.docType] });
}

/**
 * Post a non-item credit/debit note as a balanced journal.
 *
 * CREDIT note (sales side): Dr discount/variance account / Cr AR (party) —
 *   the customer owes less.
 * DEBIT note (purchase side): Dr AP (party) / Cr discount/variance account —
 *   we owe the supplier less.
 *
 * Never moves stock or cash. The source document (if linked) is not
 * rewritten; the note appears in its history via source_doc_id.
 */
export async function postNote(tx: DbTx, input: PostNoteInput): Promise<PostNoteResult> {
  if (input.amount <= 0n) throw new UserError("Note amount must be positive.");
  const isCredit = input.kind === "CREDIT";

  // Party must exist, belong to the company, and sit on the right side.
  const partyRows = await tx
    .select({ kind: parties.kind, name: parties.name })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const party = partyRows[0];
  if (!party) throw new UserError("Party not found.");
  if (isCredit ? party.kind !== "CUSTOMER" : party.kind !== "SUPPLIER") {
    throw new UserError(
      isCredit ? "A credit note can only be issued to a customer." : "A debit note can only be issued to a supplier."
    );
  }

  // Ledger account: must be an active EXPENSE (credit note) or INCOME
  // (debit note) account of this company. Defaults to Discount Given/Received.
  const ac = await accountMap(tx, input.companyId);
  let accountId = input.accountId ?? ac[SYS[DEFAULT_ACCOUNT[input.kind]]];
  {
    const rows = await tx
      .select({ id: accounts.id, type: accounts.type, name: accounts.name, isActive: accounts.isActive })
      .from(accounts)
      .where(and(eq(accounts.id, accountId), eq(accounts.companyId, input.companyId)))
      .limit(1);
    const a = rows[0];
    if (!a || !a.isActive) throw new UserError("Selected ledger account is invalid.");
    if (a.type !== "EXPENSE" && a.type !== "INCOME") {
      throw new UserError("The note account must be an expense or income account.");
    }
    accountId = a.id;
  }

  // Optional source document: must belong to the same party + company.
  let sourceDocNo: string | null = null;
  if (input.sourceDocId) {
    const tbl = isCredit ? salesDocs : purchaseDocs;
    const wantType = isCredit ? "INVOICE" : "BILL";
    const rows = await tx
      .select({ docNo: tbl.docNo, docType: tbl.docType, partyId: tbl.partyId })
      .from(tbl)
      .where(and(eq(tbl.id, input.sourceDocId), eq(tbl.companyId, input.companyId)))
      .limit(1);
    const d = rows[0];
    if (!d) throw new UserError("Linked document not found.");
    if (d.docType !== wantType) {
      throw new UserError(
        isCredit ? "A credit note can only link to a sales invoice." : "A debit note can only link to a purchase bill."
      );
    }
    if (d.partyId !== input.partyId) throw new UserError("The linked document belongs to a different party.");
    sourceDocNo = d.docNo;
  }

  await ensureNoteSequence(tx, input.companyId, input.kind);
  const docNo = await nextDocNo(tx, input.companyId, DOC_TYPE[input.kind]);
  const noteId = crypto.randomUUID();

  const arApAccount = isCredit ? ac[SYS.AR] : ac[SYS.AP];
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `${isCredit ? "Credit note" : "Debit note"} ${docNo} — ${party.name}${
      sourceDocNo ? ` (against ${sourceDocNo})` : ""
    }`,
    reference: docNo,
    source: "NOTE",
    sourceId: noteId,
    createdById: input.createdById,
    lines: isCredit
      ? [
          { accountId, debit: input.amount, credit: 0n },
          { accountId: arApAccount, debit: 0n, credit: input.amount, partyId: input.partyId },
        ]
      : [
          { accountId: arApAccount, debit: input.amount, credit: 0n, partyId: input.partyId },
          { accountId, debit: 0n, credit: input.amount },
        ],
  });

  // Party balance convention: positive = outstanding. Both note kinds move
  // the balance toward us (customer owes less / we owe the supplier less).
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} + ${-input.amount}` })
    .where(eq(parties.id, input.partyId));

  await tx.insert(notes).values({
    id: noteId,
    companyId: input.companyId,
    branchId: input.branchId,
    kind: DOC_TYPE[input.kind],
    docNo,
    date: input.date,
    partyId: input.partyId,
    accountId,
    sourceDocId: input.sourceDocId ?? null,
    amount: input.amount,
    notes: input.notes ?? null,
    journalEntryId: entryId,
    createdById: input.createdById,
    createdAt: new Date(),
  });

  return { id: noteId, docNo, journalEntryId: entryId };
}
