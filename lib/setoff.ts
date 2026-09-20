import { eq, and, sql } from "drizzle-orm";
import { parties } from "@/db/schema";
import { createJournal } from "./posting";
import { SYS, accountMap } from "./setup";
import type { DbTx } from "./db";
import { UserError } from "./errors";

export type SetoffInput = {
  companyId: string;
  branchId: string;
  customerId: string;
  supplierId: string;
  amount: bigint; // paisa, positive
  date: Date;
  notes?: string;
  createdById: string;
};

/**
 * Set-off (contra) — nets a party that is both customer and supplier.
 *
 * Journal: Dr Accounts Payable / Cr Accounts Receivable, each line tagged
 * with the respective party so the party ledgers move correctly.
 * Both party balances drop by the amount; the entry is fully balanced.
 */
export async function postSetoff(tx: DbTx, input: SetoffInput): Promise<string> {
  if (input.amount <= 0n) throw new UserError("Set-off amount must be positive.");
  if (input.customerId === input.supplierId) throw new UserError("Customer and supplier must be different parties.");

  const [customer] = await tx
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, input.customerId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const [supplier] = await tx
    .select({ id: parties.id, name: parties.name, kind: parties.kind, balance: parties.balance })
    .from(parties)
    .where(and(eq(parties.id, input.supplierId), eq(parties.companyId, input.companyId)))
    .limit(1);
  if (!customer) throw new UserError("Customer not found.");
  if (!supplier) throw new UserError("Supplier not found.");
  if (customer.kind !== "CUSTOMER") throw new UserError("First party must be a customer.");
  if (supplier.kind !== "SUPPLIER") throw new UserError("Second party must be a supplier.");

  const custBal = BigInt(customer.balance); // +ve = they owe us
  const suppBal = BigInt(supplier.balance); // +ve = we owe them
  if (custBal <= 0n) throw new UserError(`${customer.name} has no receivable to set off.`);
  if (suppBal <= 0n) throw new UserError(`${supplier.name} has no payable to set off.`);
  const max = custBal < suppBal ? custBal : suppBal;
  if (input.amount > max) throw new UserError(`Set-off cannot exceed Rs ${(max / 100n).toLocaleString()} (the smaller balance).`);

  const ac = await accountMap(tx, input.companyId);
  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    branchId: input.branchId,
    date: input.date,
    memo: `Set-off: ${customer.name} ↔ ${supplier.name}${input.notes ? ` — ${input.notes}` : ""}`,
    source: "SETOFF",
    createdById: input.createdById,
    lines: [
      { accountId: ac[SYS.AP], debit: input.amount, credit: 0n, partyId: supplier.id },
      { accountId: ac[SYS.AR], debit: 0n, credit: input.amount, partyId: customer.id },
    ],
  });

  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, customer.id));
  await tx
    .update(parties)
    .set({ balance: sql`${parties.balance} - ${input.amount}`, updatedAt: new Date() })
    .where(eq(parties.id, supplier.id));

  return entryId;
}
