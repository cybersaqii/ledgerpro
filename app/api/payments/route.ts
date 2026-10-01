import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { payments, parties, bankAccounts } from "@/db/schema";
import { paymentSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { postPayment } from "@/lib/posting";
import { validateProjectId } from "@/lib/projects";
import { validateSessionId } from "@/lib/pos-sessions";
import { fifoAllocations } from "@/lib/auto-allocate";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { approvalRequired, stageApprovalRequest, findApprovalRequestByIdemKey } from "@/lib/approvals";
import { clientIp } from "@/lib/rate-limit-db";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

// GET /api/payments?kind=RECEIPT&partyId=&from=&to=&page=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind");
  const partyId = sp.get("partyId");
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(payments.companyId, companyId)];
  if (kind === "RECEIPT" || kind === "PAYMENT") conds.push(eq(payments.kind, kind));
  if (partyId) conds.push(eq(payments.partyId, partyId));
  if (from) {
    try { conds.push(sql`${payments.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
 }
  if (to) {
    try { conds.push(sql`${payments.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
 }

  const rows = await db
    .select({ p: payments, partyName: parties.name, bankName: bankAccounts.name })
    .from(payments)
    .leftJoin(parties, eq(payments.partyId, parties.id))
    .leftJoin(bankAccounts, eq(payments.bankAccountId, bankAccounts.id))
    .where(and(...conds))
    .orderBy(desc(payments.date), desc(payments.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(payments)
    .where(and(...conds));
  const sums = await db
    .select({
      r: sql<string | null>`sum(case when ${payments.kind} = 'RECEIPT' then ${payments.amount} else 0 end)`,
      p: sql<string | null>`sum(case when ${payments.kind} = 'PAYMENT' then ${payments.amount} else 0 end)`,
 })
    .from(payments)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.p, partyName: r.partyName, bankName: r.bankName })),
    total: total[0]?.n ?? 0,
    sumReceipt: sums[0]?.r ?? "0",
    sumPayment: sums[0]?.p ?? "0",
    page,
    perPage,
 });
}

// POST /api/payments — receipt or payment, with optional invoice/bill allocations
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created payment with 200 instead of double-posting.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/payments", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, payments, companyId, idemKey);
    if (existing)
      return json(
        { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
        { status: 200 }
      );
    const staged = await findApprovalRequestByIdemKey(db, companyId, idemKey);
    if (staged)
      return json(
        {
          data: {
            approvalId: staged.id,
            docNo: staged.docNo,
            status: staged.status,
            idempotentReplay: true,
          },
        },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "payments", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);

  const date = parseDateOnly(b.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  // Module 6.3: an active approval rule stages over-threshold payments —
  // no journal, no allocation, no balance movement until approved.
  const needsApproval = await approvalRequired(db, companyId, "PAYMENT", amount);

  try {
    const paymentResult = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);

      let partyId: string;
      let partyName: string | null = null;
      {
        if (!b.partyId) throw new UserError("Please select a customer or supplier.", 422);
        const pr = await tx
          .select()
          .from(parties)
          .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId)))
          .limit(1);
        if (!pr[0]) throw new UserError("Selected party is invalid.", 422);
        partyId = pr[0].id;
        partyName = pr[0].name;
      }

      // Module 13: validate the project tag (P&L-neutral by design — tagged
      // payments move AR/AP/Bank; the tag is for cash-flow visibility).
      const projectId = await validateProjectId(tx, companyId, b.projectId);
      // Module 14: validate the POS session tag for counter refunds. A staged
      // (approval-gated) payment cannot carry a shift tag — the shift will be
      // closed before the approver runs, so the tag would miss the Z-report.
      const posSession = await validateSessionId(tx, companyId, b.sessionId);
      if (needsApproval && posSession)
        throw new Error("SESSION_TAG_STAGED");
      if (needsApproval) {
        const approvalId = await stageApprovalRequest(tx, {
          companyId,
          docType: "PAYMENT",
          partyId,
          partyName: partyName ?? undefined,
          amountPaisa: amount,
          payload: {
            projectId: projectId ?? undefined,
            kind: b.kind,
            partyId,
            branchId,
            dateISO: date.toISOString(),
            bankAccountId: b.bankAccountId,
            amountPaisa: amount.toString(),
            method: b.method,
            reference: b.reference || undefined,
            notes: b.notes || undefined,
            allocations: b.allocations.map((a) => ({
              docId: a.docId,
              docKind: a.docKind,
              amountPaisa: a.amount,
            })),
            autoAllocate: !!b.autoAllocate,
            // Module 7.2: WHT deducted at payment/receipt time.
            whtSection: (b.whtSection || "").trim() || undefined,
            whtBps: b.whtBps,
          },
          requestedById: session.uid,
          requestedByName: session.name,
          idempotencyKey: idemKey,
        });
        return { id: "", docNo: "", approvalId };
      }

      const { id: pid, docNo } = await postPayment(tx, {
        companyId,
        branchId,
        kind: b.kind,
        partyId,
        bankAccountId: b.bankAccountId,
        date,
        amount,
        method: b.method,
        projectId,
        // Module 14: POS session tag (counter refunds land in the shift summary).
        posSessionId: posSession?.id ?? null,
        reference: b.reference || undefined,
        notes: b.notes || undefined,
        // Module 1.5: FIFO auto-allocate ("Auto-fill oldest-first") — the
        // server computes oldest-first allocations in-txn so a receipt lands
        // on the right invoices even if the user skipped the allocation UI.
        // Explicit allocations always win over autoAllocate.
        allocations:
          b.autoAllocate && b.allocations.length === 0
            ? await fifoAllocations(tx, { companyId, partyId, kind: b.kind, amount })
            : b.allocations.map((a) => ({
                docId: a.docId,
                docKind: a.docKind,
                amount: parseMoney(a.amount),
              })),
        createdById: session.uid,
        // Module 7.2: WHT deducted at payment/receipt time (validated +
        // posted inside postPayment; the register row joins the same txn).
        wht: (b.whtSection || "").trim()
          ? { section: (b.whtSection || "").trim(), rateBps: b.whtBps ?? 0 }
          : undefined,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
 });
      return { id: pid, docNo, approvalId: null as string | null };
 });
    const { id: paymentId, docNo } = paymentResult;
    // Module 6.3: staged for approval — no journal, no allocation, no
    // balance movement yet.
    if (paymentResult.approvalId) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "approval.requested",
        entity: "approval", entityId: paymentResult.approvalId,
        detail: `${b.kind === "RECEIPT" ? "Receipt" : "Payment"} of Rs ${(amount / 100n).toLocaleString()} staged for approval`,
        ip: clientIp(req),
        newValues: { status: "PENDING_APPROVAL", amountPaisa: amount.toString() },
      });
      return json(
        { data: { approvalId: paymentResult.approvalId, status: "PENDING_APPROVAL" } },
        { status: 202 }
      );
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "payment.created", entity: "payment", entityId: paymentId,
      detail: `Payment ${docNo}`,
 });
    return json({ data: { id: paymentId, docNo } }, { status: 201 });
 } catch (e) {
    if (e instanceof Error && e.message === "SESSION_TAG_STAGED")
      return err(
        "This payment needs approval first and cannot be tagged to a POS shift — the shift will be closed before it is approved. Record it without the shift tag.",
        422,
        "SESSION_TAG_STAGED"
      );
    // Lost the idempotency race: a concurrent request already created the
    // payment for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, payments, companyId, idemKey);
      if (existing)
        return json(
          { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
          { status: 200 }
        );
      const staged = await findApprovalRequestByIdemKey(db, companyId, idemKey);
      if (staged)
        return json(
          {
            data: {
              approvalId: staged.id,
              docNo: staged.docNo,
              status: staged.status,
              idempotentReplay: true,
            },
          },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/payments", companyId });
 }
}
