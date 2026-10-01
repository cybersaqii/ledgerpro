/**
 * Module 7.2/7.3 — server-side tax helpers: the WHT Deduction Register
 * writer, Annexure A/C (sales-tax return) row builders and the WHT
 * certificate data fetcher. Money stays integer paisa / BigInt throughout.
 */
import { eq, and, gte, lt, desc, sql } from "drizzle-orm";
import {
  whtDeductions,
  parties,
  companies,
  salesDocs,
  salesDocItems,
  purchaseDocs,
  purchaseDocItems,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { whtSectionForCategory } from "./wht";

// ─── WHT Deduction Register ──────────────────────────────────────

export type RecordWhtDeductionInput = {
  companyId: string;
  date: Date;
  /** BILL = bill-time (Module 2); PAYMENT = supplier payment; RECEIPT = customer receipt. */
  kind: "BILL" | "PAYMENT" | "RECEIPT";
  docId?: string;
  paymentId?: string;
  journalEntryId?: string;
  partyId: string;
  taxSection: string;
  rateBps: number;
  /** Net base the tax was computed on (excl. sales tax), paisa. */
  grossPaisa: bigint;
  whtPaisa: bigint;
  createdById: string;
};

/**
 * Append one row to the WHT Deduction Register. The deductee name and
 * NTN/CNIC are snapshotted from the party master so the register and the
 * printed certificate stay stable if the party is renamed later.
 * Must be called inside the posting transaction.
 */
export async function recordWhtDeduction(
  tx: DbTx,
  input: RecordWhtDeductionInput
): Promise<string> {
  if (input.whtPaisa <= 0n) throw new Error("WHT deduction must be positive");
  if (input.grossPaisa < 0n) throw new Error("WHT gross base cannot be negative");
  if (!Number.isInteger(input.rateBps) || input.rateBps < 0 || input.rateBps > 10000)
    throw new Error("WHT rate must be between 0 and 100%");
  const partyRows = await tx
    .select({
      name: parties.name,
      displayName: parties.displayName,
      ntn: parties.ntn,
      whtCategory: parties.whtCategory,
    })
    .from(parties)
    .where(and(eq(parties.id, input.partyId), eq(parties.companyId, input.companyId)))
    .limit(1);
  const party = partyRows[0];
  if (!party) throw new Error("Party not found for WHT deduction");
  const id = crypto.randomUUID();
  await tx.insert(whtDeductions).values({
    id,
    companyId: input.companyId,
    date: input.date,
    kind: input.kind,
    docId: input.docId,
    paymentId: input.paymentId,
    journalEntryId: input.journalEntryId,
    partyId: input.partyId,
    deducteeName: party.displayName?.trim() || party.name,
    ntnCnic: party.ntn,
    taxSection: input.taxSection || whtSectionForCategory(party.whtCategory),
    rateBps: input.rateBps,
    grossPaisa: input.grossPaisa,
    whtPaisa: input.whtPaisa,
    createdById: input.createdById,
    createdAt: new Date(),
  });
  return id;
}

export type WhtDeductionRow = typeof whtDeductions.$inferSelect;

export async function listWhtDeductions(
  tx: Db | DbTx,
  companyId: string,
  opts: {
    from?: Date;
    to?: Date; // inclusive
    partyId?: string;
    section?: string;
    kind?: string;
    page?: number;
    perPage?: number;
  } = {}
): Promise<{ rows: WhtDeductionRow[]; total: number; totalWhtPaisa: bigint }> {
  const conds = [
    eq(whtDeductions.companyId, companyId),
    // Voided source docs leave the register: the deduction never happened.
    sql`${whtDeductions.voidedAt} IS NULL`,
  ];
  if (opts.from) conds.push(gte(whtDeductions.date, opts.from));
  if (opts.to) {
    const end = new Date(opts.to.getTime() + 86400000);
    conds.push(lt(whtDeductions.date, end));
  }
  if (opts.partyId) conds.push(eq(whtDeductions.partyId, opts.partyId));
  if (opts.section) conds.push(eq(whtDeductions.taxSection, opts.section));
  if (opts.kind) conds.push(eq(whtDeductions.kind, opts.kind));
  const page = Math.max(1, opts.page ?? 1);
  const perPage = Math.min(100, Math.max(1, opts.perPage ?? 25));
  const where = and(...conds);
  const rows = await tx
    .select()
    .from(whtDeductions)
    .where(where)
    .orderBy(desc(whtDeductions.date), desc(whtDeductions.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await tx
    .select({ n: sql<number>`count(*)` })
    .from(whtDeductions)
    .where(where);
  const sums = await tx
    .select({ s: sql<string | null>`sum(${whtDeductions.whtPaisa})` })
    .from(whtDeductions)
    .where(where);
  return {
    rows,
    total: total[0]?.n ?? 0,
    totalWhtPaisa: BigInt(sums[0]?.s ?? "0"),
  };
}

// ─── WHT certificate ─────────────────────────────────────────────

export type WhtCertificateData = {
  deduction: WhtDeductionRow;
  deductor: {
    name: string;
    tradeName: string | null;
    ntn: string | null;
    strn: string | null;
    address: string | null;
    city: string | null;
    phone: string | null;
  };
};

/** Data for the one-click WHT certificate print layout. */
export async function getWhtCertificateData(
  tx: Db | DbTx,
  companyId: string,
  deductionId: string
): Promise<WhtCertificateData | null> {
  const dRows = await tx
    .select()
    .from(whtDeductions)
    .where(
      and(
        eq(whtDeductions.id, deductionId),
        eq(whtDeductions.companyId, companyId),
        sql`${whtDeductions.voidedAt} IS NULL`
      )
    )
    .limit(1);
  const d = dRows[0];
  if (!d) return null;
  const cRows = await tx
    .select({
      name: companies.name,
      tradeName: companies.tradeName,
      ntn: companies.ntn,
      strn: companies.strn,
      address: companies.address,
      city: companies.city,
      phone: companies.phone,
    })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const c = cRows[0];
  return {
    deduction: d,
    deductor: {
      name: c?.name ?? "",
      tradeName: c?.tradeName ?? null,
      ntn: c?.ntn ?? null,
      strn: c?.strn ?? null,
      address: c?.address ?? null,
      city: c?.city ?? null,
      phone: c?.phone ?? null,
    },
  };
}

// ─── Annexures (sales-tax return mapping) ────────────────────────

export type AnnexureCRow = {
  docId: string;
  docNo: string;
  date: Date;
  buyerName: string;
  buyerNtn: string | null;
  docType: string; // INVOICE | RETURN
  rateBps: number;
  salesValuePaisa: bigint; // excl. sales tax
  taxPaisa: bigint;
};

export type AnnexureARow = {
  docId: string;
  docNo: string;
  vendorRef: string | null;
  date: Date;
  supplierName: string;
  supplierNtn: string | null;
  docType: string; // BILL | RETURN
  rateBps: number;
  purchaseValuePaisa: bigint; // excl. sales tax
  taxPaisa: bigint;
};

function dayRange(from: Date, to: Date) {
  const end = new Date(to.getTime() + 86400000);
  return { from, end };
}

/**
 * Annexure C — output tax, one row per posted sales-invoice line with tax.
 * Only POSTED/PARTIAL/PAID invoices count; DRAFT / PENDING_APPROVAL /
 * REJECTED and voided docs are excluded (their journals don't exist).
 */
export async function annexureCRows(
  tx: Db | DbTx,
  companyId: string,
  from: Date,
  to: Date
): Promise<AnnexureCRow[]> {
  const { end } = dayRange(from, to);
  const rows = await tx
    .select({
      docId: salesDocs.id,
      docNo: salesDocs.docNo,
      date: salesDocs.date,
      docType: salesDocs.docType,
      buyerName: parties.name,
      buyerNtn: parties.ntn,
      rateBps: salesDocItems.taxBps,
      salesValuePaisa: sql<string>`${salesDocItems.lineTotal} - ${salesDocItems.taxAmount}`,
      taxPaisa: salesDocItems.taxAmount,
    })
    .from(salesDocItems)
    .innerJoin(salesDocs, eq(salesDocs.id, salesDocItems.docId))
    .innerJoin(parties, eq(parties.id, salesDocs.partyId))
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        gte(salesDocs.date, from),
        lt(salesDocs.date, end),
        sql`${salesDocs.docType} IN ('INVOICE', 'RETURN')`,
        sql`${salesDocs.status} IN ('POSTED', 'PARTIAL', 'PAID')`,
        sql`${salesDocs.voidedAt} IS NULL`,
        sql`${salesDocItems.taxAmount} != 0`
      )
    )
    .orderBy(salesDocs.date, salesDocs.docNo);
  return rows.map((r) => ({
    ...r,
    salesValuePaisa: BigInt(r.salesValuePaisa ?? "0"),
    taxPaisa: BigInt(r.taxPaisa ?? "0"),
  }));
}

/**
 * Annexure A — input tax, one row per posted purchase-bill line with tax.
 * Same posted/voided exclusions as Annexure C.
 */
export async function annexureARows(
  tx: Db | DbTx,
  companyId: string,
  from: Date,
  to: Date
): Promise<AnnexureARow[]> {
  const { end } = dayRange(from, to);
  const rows = await tx
    .select({
      docId: purchaseDocs.id,
      docNo: purchaseDocs.docNo,
      vendorRef: purchaseDocs.refNo,
      date: purchaseDocs.date,
      docType: purchaseDocs.docType,
      supplierName: parties.name,
      supplierNtn: parties.ntn,
      rateBps: purchaseDocItems.taxBps,
      purchaseValuePaisa: sql<string>`${purchaseDocItems.lineTotal} - ${purchaseDocItems.taxAmount}`,
      taxPaisa: purchaseDocItems.taxAmount,
    })
    .from(purchaseDocItems)
    .innerJoin(purchaseDocs, eq(purchaseDocs.id, purchaseDocItems.docId))
    .innerJoin(parties, eq(parties.id, purchaseDocs.partyId))
    .where(
      and(
        eq(purchaseDocs.companyId, companyId),
        gte(purchaseDocs.date, from),
        lt(purchaseDocs.date, end),
        sql`${purchaseDocs.docType} IN ('BILL', 'RETURN')`,
        sql`${purchaseDocs.status} IN ('POSTED', 'PARTIAL', 'PAID')`,
        sql`${purchaseDocs.voidedAt} IS NULL`,
        sql`${purchaseDocItems.taxAmount} != 0`
      )
    )
    .orderBy(purchaseDocs.date, purchaseDocs.docNo);
  return rows.map((r) => ({
    ...r,
    purchaseValuePaisa: BigInt(r.purchaseValuePaisa ?? "0"),
    taxPaisa: BigInt(r.taxPaisa ?? "0"),
  }));
}
