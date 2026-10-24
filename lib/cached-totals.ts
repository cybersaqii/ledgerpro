import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  journalEntries,
  journalLines,
  parties,
  paymentAllocations,
  products,
  purchaseDocs,
  salesDocs,
  setoffAllocations,
  stockLevels,
  stockMovements,
} from "@/db/schema";
import { SYS } from "./setup";
import type { DbTx } from "./db";

/**
 * Cached-totals reconciliation (Phase P1, item 1).
 *
 * Compares the cached totals the app maintains incrementally against
 * their sources of truth, company-scoped (never cross-tenant):
 *
 *   parties.balance       <- journal lines on the company's AR (1100) /
 *                            AP (2001) accounts, joined through
 *                            journal_entries for the tenant scope.
 *                            CUSTOMER: SUM(debit - credit) on AR.
 *                            SUPPLIER: SUM(credit - debit) on AP.
 *                            A party with lines on BOTH accounts is
 *                            reported as unverifiable, never auto-fixed
 *                            (no writer should produce that state).
 *   bank_accounts.balance <- opening_balance + SUM(debit - credit) on
 *                            the bank's GL account (bank_accounts.
 *                            account_id), joined through journal_entries.
 *                            Bank creation seeds balance = opening with
 *                            NO journal (lib/setup.ts), so the opening
 *                            must be added back — it is not double
 *                            counted, because no opening journal exists.
 *   stock_levels.qty      <- SUM(in_qty - out_qty) over stock_movements
 *                            for (product, branch), scoped by the
 *                            product's company (stock_levels carries no
 *                            company_id; lib/company-delete.ts uses the
 *                            same product-scoped wipe).
 *   sales_docs.amount_paid / purchase_docs.amount_paid
 *                         <- SUM(payment_allocations) + SUM(setoff_
 *                            allocations) for the doc. Set-offs move
 *                            amountPaid without a payment row
 *                            (lib/setoff.ts), advances create real
 *                            payment_allocations (lib/advance.ts), and
 *                            voids/return-releases delete or shrink
 *                            allocation rows to match (lib/payment-
 *                            void.ts, lib/doc-actions.ts) — so the two
 *                            allocation tables together are the source.
 *                            Write-offs do NOT touch amountPaid
 *                            (lib/writeoff.ts), so writtenOffAmount
 *                            needs no adjustment here.
 *
 * Deliberately NOT recomputed (hard constraints):
 *   * Snapshot columns (line rates/descriptions, WHT deductee names,
 *     payslip/depreciation snapshots, POS session summaries, captured
 *     work-order/transfer costs) are never touched.
 *   * stock_movements.balance_qty / balance_avg are the Stock Movement
 *     Card's running balances: they are recomputed and COMPARED
 *     (movementRunningMismatches), never rewritten — rewriting history
 *     would falsify the card.
 *   * stock_levels.avg_cost is reported (avgNotes) but NEVER auto-fixed:
 *     adjustStockCost (landed cost, purchase extra cost, voids) moves
 *     the average with no movement row by design, so the latest
 *     movement's balance_avg is not authoritative for the average.
 *     A qty fix therefore keeps the stored avg_cost untouched.
 *   * A stock level with no movements at all (legacy / pre-lineage
 *     stock) is unverifiable, never auto-fixed: there is no source to
 *     recompute it from.
 *
 * Report by default; fixes apply ONLY when opts.applyFixes is true
 * (the API route exposes that as POST { applyFixes: true } — a GET
 * never writes). Fixes run inside the caller's transaction.
 * Status is recomputed only for docs in POSTED / PARTIAL / PAID with
 * writtenOffAmount = 0, mirroring lib/payment-void.ts statusAfterPaid
 * (paid >= grandTotal - returnedTotal => PAID, > 0 => PARTIAL, else
 * POSTED); DRAFT / RETURNED / WRITTEN_OFF / PENDING_APPROVAL docs keep
 * their status whatever amountPaid becomes.
 */

export type CachedTotalsDiscrepancy = {
  kind: "party" | "bank" | "stockQty" | "amountPaid";
  /** Row id of the cached-total row (null for a missing stock level). */
  id: string | null;
  label: string;
  stored: string; // bigint as string
  expected: string; // bigint as string
  fixable: boolean;
};

export type CachedTotalsResult = {
  companyId: string;
  appliedFixes: boolean;
  discrepancies: CachedTotalsDiscrepancy[];
  /** Rows that cannot be verified from any source — reported, never fixed. */
  unverifiable: { kind: string; id: string; label: string; reason: string }[];
  /** stock avg_cost drift vs the latest movement — informational only,
   *  never auto-fixed (see header: cost-only adjustments are legit). */
  avgNotes: { levelId: string; productId: string; branchId: string; stored: string; latestMovementAvg: string }[];
  /** Running-balance mismatches inside stock_movements — report only,
   *  history is never rewritten. */
  movementRunningMismatches: {
    movementId: string;
    productId: string;
    branchId: string;
    storedBalanceQty: string;
    recomputedBalanceQty: string;
  }[];
  fixed: CachedTotalsDiscrepancy[];
  checked: { parties: number; bankAccounts: number; stockLevels: number; docs: number; movements: number };
};

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(v);
  if (typeof v === "string" && v.trim() !== "") return BigInt(v);
  return 0n;
}

export async function reconcileCachedTotals(
  tx: DbTx,
  companyId: string,
  opts: { applyFixes?: boolean } = {}
): Promise<CachedTotalsResult> {
  const applyFixes = opts.applyFixes === true;
  const discrepancies: CachedTotalsDiscrepancy[] = [];
  const unverifiable: CachedTotalsResult["unverifiable"] = [];
  const avgNotes: CachedTotalsResult["avgNotes"] = [];
  const movementRunningMismatches: CachedTotalsResult["movementRunningMismatches"] = [];
  const fixed: CachedTotalsDiscrepancy[] = [];

  // ── Parties ──
  const arAp = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), inArray(accounts.code, [SYS.AR, SYS.AP])));
  const arId = arAp.find((a) => a.code === SYS.AR)?.id ?? null;
  const apId = arAp.find((a) => a.code === SYS.AP)?.id ?? null;
  const partyRows = await tx.select().from(parties).where(eq(parties.companyId, companyId));
  // net[partyId][accountId] = SUM(debit - credit)
  const net = new Map<string, Map<string, bigint>>();
  if (arId || apId) {
    const jlRows = await tx
      .select({
        partyId: journalLines.partyId,
        accountId: journalLines.accountId,
        net: sql`COALESCE(SUM(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          isNotNull(journalLines.partyId),
          inArray(
            journalLines.accountId,
            [arId, apId].filter((x): x is string => x !== null)
          )
        )
      )
      .groupBy(journalLines.partyId, journalLines.accountId);
    for (const r of jlRows) {
      if (!r.partyId) continue;
      let m = net.get(r.partyId);
      if (!m) { m = new Map(); net.set(r.partyId, m); }
      m.set(r.accountId, toBig(r.net));
    }
  }
  for (const p of partyRows) {
    const m = net.get(p.id);
    const arNet = arId ? (m?.get(arId) ?? 0n) : 0n;
    const apNet = apId ? (m?.get(apId) ?? 0n) : 0n;
    if (arNet !== 0n && apNet !== 0n) {
      unverifiable.push({
        kind: "party",
        id: p.id,
        label: p.name,
        reason: "Journal lines exist on BOTH the AR and AP accounts for this party; no single expected balance can be derived.",
      });
      continue;
    }
    const expected = p.kind === "CUSTOMER" ? arNet : -apNet;
    const stored = BigInt(p.balance);
    if (stored !== expected) {
      discrepancies.push({
        kind: "party",
        id: p.id,
        label: p.name,
        stored: stored.toString(),
        expected: expected.toString(),
        fixable: true,
      });
    }
  }

  // ── Bank accounts ──
  const bankRows = await tx.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId));
  const bankNet = new Map<string, bigint>();
  if (bankRows.length > 0) {
    const bRows = await tx
      .select({
        accountId: journalLines.accountId,
        net: sql`COALESCE(SUM(${journalLines.debit} - ${journalLines.credit}), 0)`,
      })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(
        and(
          eq(journalEntries.companyId, companyId),
          inArray(
            journalLines.accountId,
            bankRows.map((b) => b.accountId)
          )
        )
      )
      .groupBy(journalLines.accountId);
    for (const r of bRows) bankNet.set(r.accountId, toBig(r.net));
  }
  for (const b of bankRows) {
    const expected = BigInt(b.openingBalance) + (bankNet.get(b.accountId) ?? 0n);
    const stored = BigInt(b.balance);
    if (stored !== expected) {
      discrepancies.push({
        kind: "bank",
        id: b.id,
        label: b.name,
        stored: stored.toString(),
        expected: expected.toString(),
        fixable: true,
      });
    }
  }

  // ── Stock: movements recomputed in JS (order matters for running
  // balances). rowid is the append order: movements are append-only,
  // so (date, createdAt, rowid) is the ledger order even when two
  // movements share a millisecond timestamp.
  const movementRows = await tx
    .select({
      id: stockMovements.id,
      productId: stockMovements.productId,
      branchId: stockMovements.branchId,
      inQty: stockMovements.inQty,
      outQty: stockMovements.outQty,
      balanceQty: stockMovements.balanceQty,
      balanceAvg: stockMovements.balanceAvg,
      rowid: sql<number>`rowid`,
    })
    .from(stockMovements)
    .where(eq(stockMovements.companyId, companyId));
  type MovGroup = { qtySum: bigint; latestAvg: bigint; rows: typeof movementRows };
  const groups = new Map<string, MovGroup>();
  for (const m of movementRows) {
    const key = `${m.productId}|${m.branchId}`;
    let g = groups.get(key);
    if (!g) { g = { qtySum: 0n, latestAvg: 0n, rows: [] }; groups.set(key, g); }
    g.rows.push(m);
  }
  for (const g of groups.values()) {
    g.rows.sort((a, b) => a.rowid - b.rowid);
    let running = 0n;
    for (const m of g.rows) {
      running += BigInt(m.inQty) - BigInt(m.outQty);
      if (running !== BigInt(m.balanceQty)) {
        movementRunningMismatches.push({
          movementId: m.id,
          productId: m.productId,
          branchId: m.branchId,
          storedBalanceQty: BigInt(m.balanceQty).toString(),
          recomputedBalanceQty: running.toString(),
        });
      }
    }
    g.qtySum = running;
    const last = g.rows[g.rows.length - 1];
    g.latestAvg = last ? BigInt(last.balanceAvg) : 0n;
  }
  const levelRows = await tx
    .select({
      id: stockLevels.id,
      productId: stockLevels.productId,
      branchId: stockLevels.branchId,
      qty: stockLevels.qty,
      avgCost: stockLevels.avgCost,
    })
    .from(stockLevels)
    .innerJoin(products, eq(stockLevels.productId, products.id))
    .where(eq(products.companyId, companyId));
  const seenGroups = new Set<string>();
  for (const l of levelRows) {
    const key = `${l.productId}|${l.branchId}`;
    seenGroups.add(key);
    const g = groups.get(key);
    if (!g) {
      unverifiable.push({
        kind: "stockQty",
        id: l.id,
        label: `${l.productId} @ ${l.branchId}`,
        reason: "No stock movements exist for this product/branch (legacy or pre-lineage stock); there is no source to recompute the level from.",
      });
      continue;
    }
    if (BigInt(l.qty) !== g.qtySum) {
      discrepancies.push({
        kind: "stockQty",
        id: l.id,
        label: `${l.productId} @ ${l.branchId}`,
        stored: BigInt(l.qty).toString(),
        expected: g.qtySum.toString(),
        fixable: true,
      });
    }
    if (BigInt(l.avgCost) !== g.latestAvg) {
      avgNotes.push({
        levelId: l.id,
        productId: l.productId,
        branchId: l.branchId,
        stored: BigInt(l.avgCost).toString(),
        latestMovementAvg: g.latestAvg.toString(),
      });
    }
  }
  for (const [key, g] of groups) {
    if (seenGroups.has(key)) continue;
    if (g.qtySum === 0n) continue; // movements net to zero, no level needed
    const [productId, branchId] = key.split("|");
    discrepancies.push({
      kind: "stockQty",
      id: null,
      label: `${productId} @ ${branchId}`,
      stored: "0 (no stock_levels row)",
      expected: g.qtySum.toString(),
      fixable: true,
    });
  }

  // ── amountPaid (sales + purchase) ──
  // Note: payment_allocations carries no company_id, so its sums are
  // joined back through the doc's company below — a stray allocation to
  // another company's doc can never match a doc in this company, and
  // allocations to docs of this company are exactly this company's.
  const paySum = new Map<string, bigint>();
  const setoffSum = new Map<string, bigint>();
  const addTo = (map: Map<string, bigint>, id: string | null, amount: bigint) => {
    if (!id) return;
    map.set(id, (map.get(id) ?? 0n) + amount);
  };
  const payRows = await tx
    .select({
      salesDocId: paymentAllocations.salesDocId,
      purchaseDocId: paymentAllocations.purchaseDocId,
      total: sql`COALESCE(SUM(${paymentAllocations.amount}), 0)`,
    })
    .from(paymentAllocations)
    .groupBy(paymentAllocations.salesDocId, paymentAllocations.purchaseDocId);
  for (const r of payRows) {
    addTo(paySum, r.salesDocId, toBig(r.total));
    addTo(paySum, r.purchaseDocId, toBig(r.total));
  }
  const soRows = await tx
    .select({
      salesDocId: setoffAllocations.salesDocId,
      purchaseDocId: setoffAllocations.purchaseDocId,
      total: sql`COALESCE(SUM(${setoffAllocations.amount}), 0)`,
    })
    .from(setoffAllocations)
    .where(eq(setoffAllocations.companyId, companyId))
    .groupBy(setoffAllocations.salesDocId, setoffAllocations.purchaseDocId);
  for (const r of soRows) {
    addTo(setoffSum, r.salesDocId, toBig(r.total));
    addTo(setoffSum, r.purchaseDocId, toBig(r.total));
  }
  const salesRows = await tx.select().from(salesDocs).where(eq(salesDocs.companyId, companyId));
  const purchRows = await tx.select().from(purchaseDocs).where(eq(purchaseDocs.companyId, companyId));
  const docDiscrepancies: { table: "sales" | "purchase"; id: string; docNo: string; stored: bigint; expected: bigint; status: string; grandTotal: bigint; returnedTotal: bigint; writtenOffAmount: bigint }[] = [];
  for (const d of salesRows) {
    const expected = (paySum.get(d.id) ?? 0n) + (setoffSum.get(d.id) ?? 0n);
    if (BigInt(d.amountPaid) !== expected) {
      docDiscrepancies.push({
        table: "sales", id: d.id, docNo: d.docNo, stored: BigInt(d.amountPaid), expected,
        status: d.status, grandTotal: BigInt(d.grandTotal), returnedTotal: BigInt(d.returnedTotal),
        writtenOffAmount: BigInt(d.writtenOffAmount),
      });
      discrepancies.push({ kind: "amountPaid", id: d.id, label: `sales ${d.docNo}`, stored: BigInt(d.amountPaid).toString(), expected: expected.toString(), fixable: true });
    }
  }
  for (const d of purchRows) {
    const expected = (paySum.get(d.id) ?? 0n) + (setoffSum.get(d.id) ?? 0n);
    if (BigInt(d.amountPaid) !== expected) {
      docDiscrepancies.push({
        table: "purchase", id: d.id, docNo: d.docNo, stored: BigInt(d.amountPaid), expected,
        status: d.status, grandTotal: BigInt(d.grandTotal), returnedTotal: BigInt(d.returnedTotal),
        writtenOffAmount: BigInt(d.writtenOffAmount),
      });
      discrepancies.push({ kind: "amountPaid", id: d.id, label: `purchase ${d.docNo}`, stored: BigInt(d.amountPaid).toString(), expected: expected.toString(), fixable: true });
    }
  }

  // ── Apply fixes (caller transaction) ──
  if (applyFixes) {
    for (const d of discrepancies) {
      if (!d.fixable) continue;
      if (d.kind === "party") {
        await tx.update(parties).set({ balance: BigInt(d.expected), updatedAt: new Date() }).where(eq(parties.id, d.id!));
      } else if (d.kind === "bank") {
        await tx.update(bankAccounts).set({ balance: BigInt(d.expected) }).where(eq(bankAccounts.id, d.id!));
      } else if (d.kind === "stockQty") {
        if (d.id) {
          await tx.update(stockLevels).set({ qty: BigInt(d.expected) }).where(eq(stockLevels.id, d.id));
        } else {
          const [productId, branchId] = d.label.split(" @ ");
          const g = groups.get(`${productId}|${branchId}`);
          await tx.insert(stockLevels).values({
            id: crypto.randomUUID(),
            productId: productId!,
            branchId: branchId!,
            qty: BigInt(d.expected),
            avgCost: g?.latestAvg ?? 0n,
          });
        }
      } else if (d.kind === "amountPaid") {
        const doc = docDiscrepancies.find((x) => x.id === d.id)!;
        const set: { amountPaid: bigint; updatedAt: Date; status?: string } = { amountPaid: BigInt(d.expected), updatedAt: new Date() };
        if ((doc.status === "POSTED" || doc.status === "PARTIAL" || doc.status === "PAID") && doc.writtenOffAmount === 0n) {
          const net = doc.grandTotal - doc.returnedTotal;
          set.status = BigInt(d.expected) >= net ? "PAID" : BigInt(d.expected) > 0n ? "PARTIAL" : "POSTED";
        }
        if (doc.table === "sales") {
          await tx.update(salesDocs).set(set).where(eq(salesDocs.id, d.id!));
        } else {
          await tx.update(purchaseDocs).set(set).where(eq(purchaseDocs.id, d.id!));
        }
      }
      fixed.push(d);
    }
  }

  return {
    companyId,
    appliedFixes: applyFixes,
    discrepancies: applyFixes ? discrepancies.filter((d) => !fixed.includes(d)) : discrepancies,
    unverifiable,
    avgNotes,
    movementRunningMismatches,
    fixed,
    checked: {
      parties: partyRows.length,
      bankAccounts: bankRows.length,
      stockLevels: levelRows.length,
      docs: salesRows.length + purchRows.length,
      movements: movementRows.length,
    },
  };
}
