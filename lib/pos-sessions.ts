/**
 * Module 14 — POS register sessions (shifts).
 *
 * A register session tracks one counter's drawer from open to close:
 *   OPEN (starting cash float) → CLOSED (counted cash, expected vs actual,
 *   shift variance journal).
 *
 * Money is integer paisa / bigint throughout. Every query is scoped by
 * companyId. The variance journal always balances Dr == Cr and respects the
 * accounting period lock.
 */
import { eq, and, inArray } from "drizzle-orm";
import {
  posTerminals,
  posSessions,
  posCashMovements,
  salesDocs,
  salesDocItems,
  payments,
  bankAccounts,
} from "@/db/schema";
import type { DbTx } from "./db";
import { createJournal } from "./posting";
import { accountMap, SYS } from "./setup";
import { assertPeriodOpen } from "./period";
import { UserError } from "./errors";

export type PosSession = typeof posSessions.$inferSelect;
export type PosTerminal = typeof posTerminals.$inferSelect;

/** Live-computed shift summary (bigint paisa). */
export interface SessionSummary {
  salesCount: number;
  totalSalesPaisa: bigint;
  totalDiscountPaisa: bigint;
  totalTaxPaisa: bigint;
  cashSalesPaisa: bigint; // receipts into the drawer account
  cardSalesPaisa: bigint; // receipts into any non-drawer account
  returnsCount: number;
  returnsTotalPaisa: bigint;
  cashRefundsPaisa: bigint; // refunds paid out of the drawer account
  cashInPaisa: bigint; // paid-in drawer movements
  cashOutPaisa: bigint; // paid-out drawer movements
  openingCashPaisa: bigint;
  expectedCashPaisa: bigint; // opening + cashSales − cashRefunds + cashIn − cashOut
}

/** Load an OPEN session, company-scoped. Throws when missing or closed. */
export async function requireOpenSession(tx: DbTx, companyId: string, sessionId: string): Promise<PosSession> {
  const rows = await tx
    .select()
    .from(posSessions)
    .where(and(eq(posSessions.id, sessionId), eq(posSessions.companyId, companyId)))
    .limit(1);
  const s = rows[0];
  if (!s) throw new UserError("POS session not found.", 404, "SESSION_NOT_FOUND");
  if (s.status !== "OPEN") throw new UserError("This POS session is already closed.", 422, "SESSION_NOT_OPEN");
  return s;
}

/**
 * Validate a session id coming from a document/payment/checkout payload:
 * null/empty passes through (tagging is optional); a provided id must be an
 * OPEN session of this company. Returns the session row or null.
 */
export async function validateSessionId(
  tx: DbTx,
  companyId: string,
  sessionId: string | null | undefined
): Promise<PosSession | null> {
  const id = (sessionId || "").trim();
  if (!id) return null;
  return requireOpenSession(tx, companyId, id);
}

/** The currently open session for a terminal, if any. */
export async function getOpenSession(
  tx: DbTx,
  companyId: string,
  terminalId: string
): Promise<PosSession | null> {
  const rows = await tx
    .select()
    .from(posSessions)
    .where(
      and(
        eq(posSessions.companyId, companyId),
        eq(posSessions.terminalId, terminalId),
        eq(posSessions.status, "OPEN")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Load an active terminal, company-scoped. */
export async function requireTerminal(tx: DbTx, companyId: string, terminalId: string): Promise<PosTerminal> {
  const rows = await tx
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, terminalId), eq(posTerminals.companyId, companyId)))
    .limit(1);
  const t = rows[0];
  if (!t) throw new UserError("POS terminal not found.", 404, "TERMINAL_NOT_FOUND");
  if (!t.isActive) throw new UserError("This POS terminal is deactivated.", 422, "TERMINAL_INACTIVE");
  return t;
}

/**
 * Open a register shift. Fails with 409 SESSION_ALREADY_OPEN when the
 * terminal already has an open session. Idempotent on idempotencyKey:
 * replays the existing session instead of opening a second one.
 */
export async function openSession(
  tx: DbTx,
  opts: {
    companyId: string;
    terminalId: string;
    openingCashPaisa: bigint;
    notes?: string;
    createdById: string;
    idempotencyKey?: string;
  }
): Promise<{ session: PosSession; idempotentReplay: boolean }> {
  const { companyId, terminalId } = opts;
  if (opts.openingCashPaisa < 0n) throw new UserError("Opening cash cannot be negative.", 422);
  const terminal = await requireTerminal(tx, companyId, terminalId);

  if (opts.idempotencyKey) {
    const prior = await tx
      .select()
      .from(posSessions)
      .where(and(eq(posSessions.companyId, companyId), eq(posSessions.idempotencyKey, opts.idempotencyKey)))
      .limit(1);
    if (prior[0]) return { session: prior[0], idempotentReplay: true };
  }
  const already = await getOpenSession(tx, companyId, terminalId);
  if (already)
    throw new UserError(
      `Terminal "${terminal.name}" already has an open shift. Close it before opening a new one.`,
      409,
      "SESSION_ALREADY_OPEN"
    );

  const id = crypto.randomUUID();
  const now = new Date();
  await tx.insert(posSessions).values({
    id,
    companyId,
    branchId: terminal.branchId,
    terminalId: terminal.id,
    terminalName: terminal.name,
    cashAccountId: terminal.cashAccountId,
    status: "OPEN",
    openedById: opts.createdById,
    openedAt: now,
    openingCashPaisa: opts.openingCashPaisa,
    notes: opts.notes || null,
    idempotencyKey: opts.idempotencyKey || null,
    createdAt: now,
    updatedAt: now,
  });
  const rows = await tx.select().from(posSessions).where(eq(posSessions.id, id)).limit(1);
  return { session: rows[0], idempotentReplay: false };
}

/**
 * Record a paid-in / paid-out drawer movement. Drawer-only accounting: no
 * journal is posted — the movement adjusts the shift's expected cash.
 */
export async function recordCashMovement(
  tx: DbTx,
  opts: {
    companyId: string;
    sessionId: string;
    kind: "CASH_IN" | "CASH_OUT";
    amountPaisa: bigint;
    reason: string;
    createdById: string;
    idempotencyKey?: string;
  }
): Promise<{ id: string; idempotentReplay: boolean }> {
  const { companyId, sessionId } = opts;
  await requireOpenSession(tx, companyId, sessionId);
  if (opts.amountPaisa <= 0n) throw new UserError("Movement amount must be positive.", 422);
  if (opts.idempotencyKey) {
    const prior = await tx
      .select({ id: posCashMovements.id })
      .from(posCashMovements)
      .where(and(eq(posCashMovements.companyId, companyId), eq(posCashMovements.idempotencyKey, opts.idempotencyKey)))
      .limit(1);
    if (prior[0]) return { id: prior[0].id, idempotentReplay: true };
  }
  const id = crypto.randomUUID();
  await tx.insert(posCashMovements).values({
    id,
    companyId,
    sessionId,
    kind: opts.kind,
    amountPaisa: opts.amountPaisa,
    reason: opts.reason,
    createdById: opts.createdById,
    idempotencyKey: opts.idempotencyKey || null,
  });
  return { id, idempotentReplay: false };
}

/**
 * Compute the live shift summary from tagged documents:
 *  - sales / returns: POSTED sales_docs (INVOICE / RETURN) tagged to the session
 *  - cashSales / cashRefunds: tagged RECEIPT / PAYMENT payments through the
 *    drawer's bank account; non-drawer receipts count as card/online sales
 *  - cashIn / cashOut: drawer movements
 *  - expectedCash = opening + cashSales − cashRefunds + cashIn − cashOut
 */
export async function computeSessionSummary(
  tx: DbTx,
  companyId: string,
  sessionId: string
): Promise<SessionSummary> {
  const s = await requireOpenSession(tx, companyId, sessionId);

  // Posted economic activity only: a fully-paid counter invoice flips to
  // PAID (and partial ones to PARTIAL) — the shift sold it either way.
  // DRAFT / PENDING_APPROVAL / VOID docs never count.
  const docs = await tx
    .select({
      docId: salesDocs.id,
      docType: salesDocs.docType,
      grandTotal: salesDocs.grandTotal,
      discountTotal: salesDocs.discountTotal,
      taxTotal: salesDocs.taxTotal,
      // Line discounts live on the items (computeTotals' itemDiscount), so
      // join them in — the shift's "discounts" figure is bill + line.
      itemDiscount: salesDocItems.discount,
    })
    .from(salesDocs)
    .leftJoin(salesDocItems, eq(salesDocItems.docId, salesDocs.id))
    .where(
      and(
        eq(salesDocs.companyId, companyId),
        eq(salesDocs.posSessionId, sessionId),
        inArray(salesDocs.status, ["POSTED", "PARTIAL", "PAID"]),
        inArray(salesDocs.docType, ["INVOICE", "RETURN"])
      )
    );
  // One row per (doc, item): fold back to per-doc aggregates.
  const perDoc = new Map<string, { docType: string; grandTotal: bigint; discountTotal: bigint; taxTotal: bigint; itemDiscount: bigint }>();
  for (const d of docs) {
    let agg = perDoc.get(d.docId);
    if (!agg) {
      agg = { docType: d.docType, grandTotal: d.grandTotal, discountTotal: d.discountTotal, taxTotal: d.taxTotal, itemDiscount: 0n };
      perDoc.set(d.docId, agg);
    }
    agg.itemDiscount += d.itemDiscount ?? 0n;
  }
  let salesCount = 0;
  let totalSalesPaisa = 0n;
  let totalDiscountPaisa = 0n;
  let totalTaxPaisa = 0n;
  let returnsCount = 0;
  let returnsTotalPaisa = 0n;
  for (const d of perDoc.values()) {
    if (d.docType === "RETURN") {
      returnsCount += 1;
      returnsTotalPaisa += d.grandTotal;
    } else {
      salesCount += 1;
      totalSalesPaisa += d.grandTotal;
      totalDiscountPaisa += d.discountTotal + d.itemDiscount;
      totalTaxPaisa += d.taxTotal;
    }
  }

  const payRows = await tx
    .select({
      kind: payments.kind,
      bankAccountId: payments.bankAccountId,
      amount: payments.amount,
    })
    .from(payments)
    .where(and(eq(payments.companyId, companyId), eq(payments.posSessionId, sessionId)));
  let cashSalesPaisa = 0n;
  let cardSalesPaisa = 0n;
  let cashRefundsPaisa = 0n;
  for (const p of payRows) {
    const amt = p.amount ?? 0n;
    if (p.kind === "RECEIPT") {
      if (p.bankAccountId === s.cashAccountId) cashSalesPaisa += amt;
      else cardSalesPaisa += amt;
    } else if (p.kind === "PAYMENT" && p.bankAccountId === s.cashAccountId) {
      cashRefundsPaisa += amt;
    }
  }

  const moves = await tx
    .select({ kind: posCashMovements.kind, amount: posCashMovements.amountPaisa })
    .from(posCashMovements)
    .where(and(eq(posCashMovements.companyId, companyId), eq(posCashMovements.sessionId, sessionId)));
  let cashInPaisa = 0n;
  let cashOutPaisa = 0n;
  for (const m of moves) {
    if (m.kind === "CASH_IN") cashInPaisa += m.amount;
    else cashOutPaisa += m.amount;
  }

  const openingCashPaisa = s.openingCashPaisa ?? 0n;
  const expectedCashPaisa =
    openingCashPaisa + cashSalesPaisa - cashRefundsPaisa + cashInPaisa - cashOutPaisa;

  return {
    salesCount,
    totalSalesPaisa,
    totalDiscountPaisa,
    totalTaxPaisa,
    cashSalesPaisa,
    cardSalesPaisa,
    returnsCount,
    returnsTotalPaisa,
    cashRefundsPaisa,
    cashInPaisa,
    cashOutPaisa,
    openingCashPaisa,
    expectedCashPaisa,
  };
}

/**
 * Close a shift: compute the summary, compare with the counted cash, post a
 * balanced variance journal when they differ, and store the snapshot.
 * Idempotent — re-closing a CLOSED session replays its stored snapshot
 * without posting a second journal.
 */
export async function closeSession(
  tx: DbTx,
  opts: {
    companyId: string;
    sessionId: string;
    countedCashPaisa: bigint;
    notes?: string;
    closedById: string;
  }
): Promise<{
  session: PosSession;
  summary: SessionSummary;
  countedCashPaisa: bigint;
  expectedCashPaisa: bigint;
  variancePaisa: bigint;
  varianceEntryId: string | null;
  idempotentReplay: boolean;
}> {
  const { companyId, sessionId } = opts;
  const rows = await tx
    .select()
    .from(posSessions)
    .where(and(eq(posSessions.companyId, companyId), eq(posSessions.id, sessionId)))
    .limit(1);
  const s = rows[0];
  if (!s) throw new UserError("POS session not found.", 404, "SESSION_NOT_FOUND");

  // Idempotent replay: the shift is already closed — return its snapshot.
  if (s.status === "CLOSED") {
    const summary: SessionSummary = {
      salesCount: s.salesCount ?? 0,
      totalSalesPaisa: s.totalSalesPaisa ?? 0n,
      totalDiscountPaisa: s.totalDiscountPaisa ?? 0n,
      totalTaxPaisa: s.totalTaxPaisa ?? 0n,
      cashSalesPaisa: s.cashSalesPaisa ?? 0n,
      cardSalesPaisa: s.cardSalesPaisa ?? 0n,
      returnsCount: s.returnsCount ?? 0,
      returnsTotalPaisa: s.returnsTotalPaisa ?? 0n,
      cashRefundsPaisa: s.cashRefundsPaisa ?? 0n,
      cashInPaisa: s.cashInPaisa ?? 0n,
      cashOutPaisa: s.cashOutPaisa ?? 0n,
      openingCashPaisa: s.openingCashPaisa ?? 0n,
      expectedCashPaisa: s.expectedCashPaisa ?? 0n,
    };
    return {
      session: s,
      summary,
      countedCashPaisa: s.countedCashPaisa ?? 0n,
      expectedCashPaisa: s.expectedCashPaisa ?? 0n,
      variancePaisa: s.variancePaisa ?? 0n,
      varianceEntryId: s.varianceEntryId,
      idempotentReplay: true,
    };
  }

  if (opts.countedCashPaisa < 0n) throw new UserError("Counted cash cannot be negative.", 422);

  // The variance journal posts on the close date — the period lock applies.
  const now = new Date();
  await assertPeriodOpen(tx, companyId, now);

  const summary = await computeSessionSummary(tx, companyId, sessionId);
  const expectedCashPaisa = summary.expectedCashPaisa;
  const variancePaisa = opts.countedCashPaisa - expectedCashPaisa;

  let varianceEntryId: string | null = null;
  if (variancePaisa !== 0n) {
    // Drawer's GL account (bank_accounts.account_id) keeps the drawer in sync.
    const baRows = await tx
      .select({ accountId: bankAccounts.accountId })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.id, s.cashAccountId), eq(bankAccounts.companyId, companyId)))
      .limit(1);
    const drawerGl = baRows[0]?.accountId;
    if (!drawerGl) throw new UserError("The session's drawer cash account no longer exists.", 422, "DRAWER_ACCOUNT_MISSING");
    const ac = await accountMap(tx, companyId);
    const amt = variancePaisa < 0n ? -variancePaisa : variancePaisa;
    const lines =
      variancePaisa < 0n
        ? // Shortage: the drawer is short — Dr Cash Shortage / Cr Cash.
          [
            { accountId: ac[SYS.CASH_SHORTAGE], debit: amt, credit: 0n },
            { accountId: drawerGl, debit: 0n, credit: amt },
          ]
        : // Overage: extra cash in the drawer — Dr Cash / Cr Cash Overage.
          [
            { accountId: drawerGl, debit: amt, credit: 0n },
            { accountId: ac[SYS.CASH_OVERAGE], debit: 0n, credit: amt },
          ];
    varianceEntryId = await createJournal(tx, {
      companyId,
      branchId: s.branchId,
      date: now,
      memo: `POS shift variance — ${s.terminalName} (${variancePaisa < 0n ? "shortage" : "overage"})`,
      source: "POS_VARIANCE",
      sourceId: sessionId,
      // Double-submit protection: a retried close can never post two journals.
      idempotencyKey: `pos-variance:${sessionId}`,
      createdById: opts.closedById,
      lines,
    });
  }

  await tx
    .update(posSessions)
    .set({
      status: "CLOSED",
      closedById: opts.closedById,
      closedAt: now,
      countedCashPaisa: opts.countedCashPaisa,
      expectedCashPaisa,
      variancePaisa,
      cashSalesPaisa: summary.cashSalesPaisa,
      cardSalesPaisa: summary.cardSalesPaisa,
      totalSalesPaisa: summary.totalSalesPaisa,
      totalDiscountPaisa: summary.totalDiscountPaisa,
      totalTaxPaisa: summary.totalTaxPaisa,
      salesCount: summary.salesCount,
      cashRefundsPaisa: summary.cashRefundsPaisa,
      returnsCount: summary.returnsCount,
      returnsTotalPaisa: summary.returnsTotalPaisa,
      cashInPaisa: summary.cashInPaisa,
      cashOutPaisa: summary.cashOutPaisa,
      varianceEntryId,
      notes: opts.notes || s.notes,
      updatedAt: now,
    })
    .where(eq(posSessions.id, sessionId));

  const updated = await tx.select().from(posSessions).where(eq(posSessions.id, sessionId)).limit(1);
  return {
    session: updated[0],
    summary,
    countedCashPaisa: opts.countedCashPaisa,
    expectedCashPaisa,
    variancePaisa,
    varianceEntryId,
    idempotentReplay: false,
  };
}
