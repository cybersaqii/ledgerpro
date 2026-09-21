import { and, eq } from "drizzle-orm";
import { parties } from "@/db/schema";
import type { DbTx } from "./db";

export interface CreditLimitDetails {
  partyName: string;
  /** paisa, serialized as string */
  limitPaisa: string;
  /** paisa, serialized as string */
  balancePaisa: string;
}

/**
 * Thrown (and answered as 409 + code CREDIT_LIMIT_EXCEEDED) when a posted
 * credit sale would push a customer's udhaar past their credit limit.
 * A limit of 0 means unlimited.
 *
 * Standalone Error subclass (not UserError): this module is also imported by
 * client components, and lib/errors pulls in next/headers via lib/api.
 * Both API routes check `instanceof CreditLimitError` before toApiError.
 */
export class CreditLimitError extends Error {
  status = 409;
  details: CreditLimitDetails;
  constructor(details: CreditLimitDetails) {
    super("Credit limit exceeded.");
    this.name = "CreditLimitError";
    this.details = details;
  }
}

/**
 * Enforce a customer's credit limit. Call INSIDE the posting transaction,
 * AFTER the doc (and any payments/advances) have posted, so the cached
 * party balance already reflects the new udhaar. Throws CreditLimitError
 * when this transaction added udhaar (newCreditPaisa > 0) and the resulting
 * balance exceeds a non-zero limit. A limit of 0 means unlimited.
 */
export async function enforceCreditLimit(
  tx: DbTx,
  opts: { companyId: string; partyId: string; newCreditPaisa: bigint }
): Promise<void> {
  if (opts.newCreditPaisa <= 0n) return;
  const rows = await tx
    .select({ id: parties.id, name: parties.name, balance: parties.balance, creditLimit: parties.creditLimit })
    .from(parties)
    .where(and(eq(parties.id, opts.partyId), eq(parties.companyId, opts.companyId)))
    .limit(1);
  const p = rows[0];
  if (!p) return;
  if (p.creditLimit > 0n && p.balance > p.creditLimit) {
    throw new CreditLimitError({
      partyName: p.name,
      limitPaisa: p.creditLimit.toString(),
      balancePaisa: p.balance.toString(),
    });
  }
}

/** Credit-limit utilization 0..1 (null when unlimited). For list badges/bars. */
export function creditUtilization(balancePaisa: bigint, limitPaisa: bigint): number | null {
  if (limitPaisa <= 0n) return null;
  if (balancePaisa <= 0n) return 0;
  return Number(balancePaisa) / Number(limitPaisa);
}
