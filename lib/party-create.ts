import { eq, and } from "drizzle-orm";
import { parties, journalEntries, journalLines } from "@/db/schema";
import { assertPeriodOpen } from "./period";
import { SYS, sysAccount } from "./setup";
import { UserError } from "./errors";
import type { DbTx } from "./db";

export type PartyCreateFields = {
  kind: "CUSTOMER" | "SUPPLIER";
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  city?: string | null;
  ntn?: string | null;
  customerType?: "INDIVIDUAL" | "REGISTERED_BUSINESS";
  currency?: string | null;
  strn?: string | null;
  openingBalance?: bigint;
  openingBalanceDate?: Date | null;
  paymentTerms?: "NET_15" | "NET_30" | "NET_45" | "DUE_ON_RECEIPT" | null;
  shippingAddress?: string | null;
  shippingCity?: string | null;
  filerStatus?: "FILER" | "NON_FILER" | "NA";
  creditLimit?: bigint;
  category?: string | null;
  notes?: string | null;
  idempotencyKey?: string;
};

/**
 * Module 1.1 — create a party with an optional opening balance, in one
 * transaction. The opening balance posts a balanced opening journal on the
 * opening date (customer: Dr AR / Cr Opening Equity 3002; supplier mirrored)
 * and seeds the party's balance, so the ledger is balanced from day one.
 * Throws UserError on duplicate names, negative openings, missing opening
 * dates, and locked periods.
 */
export async function insertParty(
  tx: DbTx,
  input: { companyId: string; userId: string; id?: string; fields: PartyCreateFields }
): Promise<{ id: string }> {
  const { companyId, userId, fields: f } = input;

  const dup = await tx
    .select({ id: parties.id })
    .from(parties)
    .where(and(eq(parties.companyId, companyId), eq(parties.kind, f.kind), eq(parties.name, f.name)))
    .limit(1);
  if (dup[0])
    throw new UserError(
      `A ${f.kind === "CUSTOMER" ? "customer" : "supplier"} with this name already exists.`,
      409,
      "DUPLICATE"
    );

  const opening = f.openingBalance ?? 0n;
  if (opening < 0n) throw new UserError("Opening balance cannot be negative.", 422, "VALIDATION_ERROR");
  const openingDate = opening > 0n ? f.openingBalanceDate ?? null : null;
  if (opening > 0n && !openingDate)
    throw new UserError("Opening balance needs an opening date.", 422, "VALIDATION_ERROR");
  if (openingDate) await assertPeriodOpen(tx, companyId, openingDate);

  const id = input.id ?? crypto.randomUUID();
  await tx.insert(parties).values({
    id,
    companyId,
    kind: f.kind,
    name: f.name,
    phone: f.phone || null,
    email: f.email || null,
    address: f.address || null,
    city: f.city || null,
    ntn: f.ntn || null,
    customerType: f.customerType ?? "INDIVIDUAL",
    currency: f.currency || null,
    strn: f.strn || null,
    openingBalance: opening,
    openingBalanceDate: openingDate,
    paymentTerms: f.paymentTerms || null,
    shippingAddress: f.shippingAddress || null,
    shippingCity: f.shippingCity || null,
    filerStatus: f.filerStatus ?? "NA",
    creditLimit: f.creditLimit ?? 0n,
    category: f.category || null,
    notes: f.notes || null,
    balance: opening,
    ...(f.idempotencyKey ? { idempotencyKey: f.idempotencyKey } : {}),
  });

  if (opening > 0n) {
    // Opening balance journal — the party's ledger starts exactly here.
    const arApId = await sysAccount(tx, companyId, f.kind === "CUSTOMER" ? SYS.AR : SYS.AP);
    const equityId = await sysAccount(tx, companyId, SYS.OPENING_EQUITY);
    const entryId = crypto.randomUUID();
    await tx.insert(journalEntries).values({
      id: entryId,
      companyId,
      date: openingDate!,
      memo: `Opening balance — ${f.kind === "CUSTOMER" ? "customer" : "supplier"} ${f.name}`,
      reference: f.name,
      source: "OPENING",
      sourceId: id,
      createdById: userId,
    });
    await tx.insert(journalLines).values(
      f.kind === "CUSTOMER"
        ? [
            { id: crypto.randomUUID(), entryId, accountId: arApId, debit: opening, credit: 0n, partyId: id },
            { id: crypto.randomUUID(), entryId, accountId: equityId, debit: 0n, credit: opening },
          ]
        : [
            { id: crypto.randomUUID(), entryId, accountId: equityId, debit: opening, credit: 0n },
            { id: crypto.randomUUID(), entryId, accountId: arApId, debit: 0n, credit: opening, partyId: id },
          ]
    );
  }

  return { id };
}
