import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { parseMoney } from "@/lib/money";
import { recordDistributionPayment, getDistributionPaymentStatus } from "@/lib/partners";
import { distributionPayments } from "@/db/schema";
import {
  extractIdempotencyKey,
  isIdempotencyConflict,
} from "@/lib/idempotency";
import { logAudit } from "@/lib/audit";
import { eq, and } from "drizzle-orm";

const schema = z.object({
  partnerId: z.string().min(1),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  accountId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  memo: z.string().trim().max(300).optional(),
});

// POST /api/partners/distributions/[id]/payments — record a payment
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const b = schema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created payment with 200 instead of double-posting.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/partners/distributions/[id]/payments", companyId });
  }
  // distribution_payments has no doc_no column, so the shared
  // findByIdempotencyKey helper (which selects docNo) can't be used here.
  const findExisting = async () => {
    if (!idemKey) return null;
    const rows = await db
      .select({ id: distributionPayments.id })
      .from(distributionPayments)
      .where(and(eq(distributionPayments.companyId, companyId), eq(distributionPayments.idempotencyKey, idemKey)))
      .limit(1);
    return rows[0] ?? null;
  };
  if (idemKey) {
    const existing = await findExisting();
    if (existing)
      return json({ data: { id: existing.id, idempotentReplay: true } }, { status: 200 });
  }

  const date = parseDateOnly(b.data.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const payId = await db.transaction(async (tx) => {
      return recordDistributionPayment(tx, {
        companyId,
        distributionId: id,
        partnerId: b.data.partnerId,
        amountPaisa: parseMoney(b.data.amount),
        accountId: b.data.accountId,
        date,
        memo: b.data.memo,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
    });
    await logAudit(db, {
      companyId,
      userId: session.uid, userName: session.name,
      action: "partner.distribution.pay",
      entity: "distribution_payment",
      entityId: payId,
      detail: "Distribution payment recorded",
    });
    return json({ data: { id: payId } }, { status: 201 });
  } catch (e) {
    // Lost the idempotency race: a concurrent request already created the
    // payment for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findExisting();
      if (existing)
        return json({ data: { id: existing.id, idempotentReplay: true } }, { status: 200 });
    }
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}

// GET /api/partners/distributions/[id]/payments — paid/pending per partner
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;

  const status = await db.transaction(async (tx) => {
    return getDistributionPaymentStatus(tx, companyId, id);
  });
  return json({
    data: status.map((s) => ({
      ...s,
      share: s.share.toString(),
      paid: s.paid.toString(),
      pending: s.pending.toString(),
    })),
  });
}
