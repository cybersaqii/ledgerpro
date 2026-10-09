import { eq, and, sql } from "drizzle-orm";
import {
  partners,
  partnerTransactions,
  profitDistributions,
  distributionEntries,
  accounts,
} from "@/db/schema";
import { createJournal } from "@/lib/posting";
import type { DbTx } from "@/lib/db";
import { SYS } from "@/lib/setup";
import { randomUUID } from "crypto";

export type PartnerTxKind = "CONTRIBUTION" | "DRAWING" | "CAPITAL_RETURN";

const CAPITAL_CODE_START = 3011;
const CAPITAL_CODE_END = 3019;
const CURRENT_CODE_START = 3021;
const CURRENT_CODE_END = 3029;

function now() {
  return new Date();
}

/** Find the first free GL code in [start, end] for this company. */
async function freeCode(
  tx: DbTx,
  companyId: string,
  start: number,
  end: number
): Promise<string> {
  const rows = await tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        sql`CAST(${accounts.code} AS INTEGER) BETWEEN ${start} AND ${end}`
      )
    );
  const used = new Set(rows.map((r: { code: string }) => r.code));
  for (let c = start; c <= end; c++) {
    if (!used.has(String(c))) return String(c);
  }
  throw new Error("No free partner account codes left in range.");
}

/** Create a system GL account for a partner (capital or current). */
async function createPartnerAccount(
  tx: DbTx,
  companyId: string,
  code: string,
  name: string
): Promise<string> {
  const id = randomUUID();
  await tx.insert(accounts).values({
    id,
    companyId,
    code,
    name,
    type: "EQUITY",
    isSystem: true,
    isActive: true,
    openingBalance: 0n,
    updatedAt: now(),
  });
  return id;
}

export type RegisterPartnerInput = {
  companyId: string;
  name: string;
  phone?: string;
  cnic?: string;
  profitShareBps: number;
  notes?: string;
  createdById: string;
};

/**
 * Register a partner: creates 301x capital + 302x current EQUITY accounts,
 * then the partner row. All inside the caller's transaction.
 */
export async function registerPartner(tx: DbTx, input: RegisterPartnerInput) {
  const { companyId, name } = input;
  if (input.profitShareBps < 0 || input.profitShareBps > 10000) {
    throw new Error("Profit share must be between 0 and 10000 bps.");
  }
  const capitalCode = await freeCode(tx, companyId, CAPITAL_CODE_START, CAPITAL_CODE_END);
  const currentCode = await freeCode(tx, companyId, CURRENT_CODE_START, CURRENT_CODE_END);
  const capitalAccountId = await createPartnerAccount(
    tx,
    companyId,
    capitalCode,
    `Capital — ${name}`
  );
  const currentAccountId = await createPartnerAccount(
    tx,
    companyId,
    currentCode,
    `Current — ${name}`
  );
  const id = randomUUID();
  await tx.insert(partners).values({
    id,
    companyId,
    name,
    phone: input.phone ?? null,
    cnic: input.cnic ?? null,
    profitShareBps: input.profitShareBps,
    capitalAccountId,
    currentAccountId,
    isActive: true,
    notes: input.notes ?? null,
    createdAt: now(),
    updatedAt: now(),
  });
  return { id, capitalAccountId, currentAccountId, capitalCode, currentCode };
}

async function getPartner(tx: DbTx, companyId: string, partnerId: string) {
  const rows = await tx
    .select()
    .from(partners)
    .where(and(eq(partners.id, partnerId), eq(partners.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p) throw new Error("Partner not found.");
  return p;
}

export type PartnerMovementInput = {
  companyId: string;
  partnerId: string;
  kind: PartnerTxKind;
  amountPaisa: bigint;
  /** Cash/bank account on the other side. */
  accountId: string;
  date: Date;
  memo?: string;
  createdById: string;
  idempotencyKey?: string;
};

/**
 * Post a capital movement:
 * - CONTRIBUTION: Dr Cash/Bank → Cr Partner Capital
 * - DRAWING:      Dr Partner Current → Cr Cash/Bank
 * - CAPITAL_RETURN: Dr Partner Capital → Cr Cash/Bank
 */
export async function postPartnerMovement(tx: DbTx, input: PartnerMovementInput) {
  const p = await getPartner(tx, input.companyId, input.partnerId);
  if (input.amountPaisa <= 0n) throw new Error("Amount must be positive.");

  let debitAccountId: string;
  let creditAccountId: string;
  let memo: string;
  switch (input.kind) {
    case "CONTRIBUTION":
      debitAccountId = input.accountId;
      creditAccountId = p.capitalAccountId;
      memo = `Capital contribution — ${p.name}`;
      break;
    case "DRAWING":
      debitAccountId = p.currentAccountId;
      creditAccountId = input.accountId;
      memo = `Drawing — ${p.name}`;
      break;
    case "CAPITAL_RETURN":
      debitAccountId = p.capitalAccountId;
      creditAccountId = input.accountId;
      memo = `Capital returned — ${p.name}`;
      break;
  }

  const entryId = await createJournal(tx, {
    companyId: input.companyId,
    date: input.date,
    memo: input.memo || memo,
    source: "partner_transaction",
    sourceId: p.id,
    createdById: input.createdById,
    idempotencyKey: input.idempotencyKey,
    lines: [
      { accountId: debitAccountId, debit: input.amountPaisa, credit: 0n },
      { accountId: creditAccountId, debit: 0n, credit: input.amountPaisa },
    ],
  });

  const id = randomUUID();
  await tx.insert(partnerTransactions).values({
    id,
    companyId: input.companyId,
    partnerId: p.id,
    kind: input.kind,
    amountPaisa: input.amountPaisa,
    accountId: input.accountId,
    journalEntryId: entryId,
    date: input.date,
    memo: input.memo ?? null,
    createdById: input.createdById,
    createdAt: now(),
  });
  return { id, journalEntryId: entryId };
}

export type CreateDistributionInput = {
  companyId: string;
  periodStart: Date;
  periodEnd: Date;
  totalAmountPaisa: bigint; // signed: +profit / -loss
  memo?: string;
  createdById: string;
};

/** Create a DRAFT distribution run with per-partner share snapshots. */
export async function createDistribution(tx: DbTx, input: CreateDistributionInput) {
  const list = await tx
    .select()
    .from(partners)
    .where(and(eq(partners.companyId, input.companyId), eq(partners.isActive, true)));
  if (list.length === 0) throw new Error("No active partners.");

  const totalBps = list.reduce((s: number, p: { profitShareBps: number }) => s + p.profitShareBps, 0);
  if (totalBps <= 0) throw new Error("Partners have no profit share configured.");

  // Split by bps; remainder goes to the largest shareholder.
  const total = input.totalAmountPaisa;
  const shares = list.map((p) => ({
    partner: p,
    amount: (total * BigInt(p.profitShareBps)) / BigInt(totalBps),
  }));
  const assigned = shares.reduce((s: bigint, x: { amount: bigint }) => s + x.amount, 0n);
  const remainder = total - assigned;
  if (remainder !== 0n) {
    let idx = 0;
    for (let i = 1; i < shares.length; i++) {
      if (shares[i].partner.profitShareBps > shares[idx].partner.profitShareBps) idx = i;
    }
    shares[idx].amount += remainder;
  }

  const distId = randomUUID();
  await tx.insert(profitDistributions).values({
    id: distId,
    companyId: input.companyId,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    totalAmountPaisa: total,
    status: "DRAFT",
    memo: input.memo ?? null,
    createdById: input.createdById,
    createdAt: now(),
  });
  for (const s of shares) {
    await tx.insert(distributionEntries).values({
      id: randomUUID(),
      distributionId: distId,
      partnerId: s.partner.id,
      shareBps: s.partner.profitShareBps,
      amountPaisa: s.amount,
      createdAt: now(),
    });
  }
  return distId;
}

async function getDistribution(tx: DbTx, companyId: string, distributionId: string) {
  const rows = await tx
    .select()
    .from(profitDistributions)
    .where(
      and(
        eq(profitDistributions.id, distributionId),
        eq(profitDistributions.companyId, companyId)
      )
    )
    .limit(1);
  const d = rows[0];
  if (!d) throw new Error("Distribution not found.");
  return d;
}

/**
 * Post a DRAFT distribution:
 * - Profit (+): Dr 3003 Retained Earnings → Cr each partner's Current account
 * - Loss (−):   Dr each partner's Current account → Cr 3003 Retained Earnings
 */
export async function postDistribution(
  tx: DbTx,
  companyId: string,
  distributionId: string,
  createdById: string
) {
  const d = await getDistribution(tx, companyId, distributionId);
  if (d.status !== "DRAFT") throw new Error("Only DRAFT distributions can be posted.");

  const entries = await tx
    .select()
    .from(distributionEntries)
    .where(eq(distributionEntries.distributionId, distributionId));
  if (entries.length === 0) throw new Error("Distribution has no entries.");

  // Resolve retained earnings + partner current accounts.
  const reRows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, SYS.RETAINED_EARNINGS)))
    .limit(1);
  if (!reRows[0]) throw new Error("Retained earnings account missing.");
  const reId = reRows[0].id;

  const partnerIds = entries.map((e) => e.partnerId);
  const partnerRows = await tx
    .select()
    .from(partners)
    .where(and(eq(partners.companyId, companyId)));
  const currentByPartner = new Map(partnerRows.map((p) => [p.id, p.currentAccountId]));

  const isProfit = d.totalAmountPaisa >= 0n;
  const lines: { accountId: string; debit: bigint; credit: bigint }[] = [];
  if (isProfit) {
    lines.push({ accountId: reId, debit: d.totalAmountPaisa, credit: 0n });
    for (const e of entries) {
      const cur = currentByPartner.get(e.partnerId);
      if (!cur) throw new Error("Partner account missing.");
      if (e.amountPaisa !== 0n)
        lines.push({ accountId: cur, debit: 0n, credit: e.amountPaisa });
    }
  } else {
    const loss = -d.totalAmountPaisa;
    for (const e of entries) {
      const cur = currentByPartner.get(e.partnerId);
      if (!cur) throw new Error("Partner account missing.");
      const share = -e.amountPaisa;
      if (share !== 0n) lines.push({ accountId: cur, debit: share, credit: 0n });
    }
    lines.push({ accountId: reId, debit: 0n, credit: loss });
  }

  const entryId = await createJournal(tx, {
    companyId,
    date: d.periodEnd,
    memo: d.memo || `Profit distribution (${d.periodStart.toISOString().slice(0, 10)} → ${d.periodEnd.toISOString().slice(0, 10)})`,
    source: "profit_distribution",
    sourceId: distributionId,
    createdById,
    lines,
  });

  await tx
    .update(profitDistributions)
    .set({ status: "POSTED", journalEntryId: entryId })
    .where(eq(profitDistributions.id, distributionId));
  return entryId;
}

/** Void a POSTED distribution via a reversing journal (original stays immutable). */
export async function voidDistribution(
  tx: DbTx,
  companyId: string,
  distributionId: string,
  createdById: string
) {
  const d = await getDistribution(tx, companyId, distributionId);
  if (d.status !== "POSTED") throw new Error("Only POSTED distributions can be voided.");
  if (!d.journalEntryId) throw new Error("Posted distribution has no journal.");

  // Mirror image of the original journal lines.
  const { journalLines } = await import("@/db/schema");
  const orig = await tx
    .select()
    .from(journalLines)
    .where(eq(journalLines.entryId, d.journalEntryId));
  if (orig.length === 0) throw new Error("Original journal has no lines.");
  const lines = orig.map((l) => ({
    accountId: l.accountId,
    debit: BigInt(l.credit),
    credit: BigInt(l.debit),
    memo: "Void profit distribution",
  }));

  await createJournal(tx, {
    companyId,
    date: new Date(),
    memo: "Void profit distribution",
    source: "profit_distribution_void",
    sourceId: distributionId,
    createdById,
    lines,
  });
  await tx
    .update(profitDistributions)
    .set({ status: "VOIDED" })
    .where(eq(profitDistributions.id, distributionId));
}
