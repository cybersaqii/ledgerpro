import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { postPartnerMovement } from "@/lib/partners";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";
import { journalEntries, partnerTransactions } from "@/db/schema";
import { periodLockError } from "@/lib/period";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

const schema = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  accountId: z.string().min(1, "Cash/bank account required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  memo: z.string().trim().max(300).optional(),
});

// POST /api/partners/[id]/draw — drawing (Dr Current → Cr Cash)
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

  const date = b.data.date ? parseDateOnly(b.data.date) : new Date();

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created movement with 200 instead of double-posting.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/partners/[id]/draw", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
    if (existing) {
      const tx = await db
        .select({ id: partnerTransactions.id })
        .from(partnerTransactions)
        .where(eq(partnerTransactions.journalEntryId, existing.id))
        .limit(1);
      return json(
        { data: { id: tx[0]?.id ?? existing.id, journalEntryId: existing.id, idempotentReplay: true } },
        { status: 200 }
      );
    }
  }
  const rl = await throttleMoneyCreate(db, "partners-draw", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const result = await db.transaction(async (tx) => {
      return postPartnerMovement(tx, {
        companyId,
        partnerId: id,
        kind: "DRAWING",
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
      action: "partner.draw",
      entity: "partner",
      entityId: id,
      detail: `Drawing Rs ${b.data.amount}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    // Lost the idempotency race: a concurrent request already created the
    // movement for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
      if (existing) {
        const tx = await db
          .select({ id: partnerTransactions.id })
          .from(partnerTransactions)
          .where(eq(partnerTransactions.journalEntryId, existing.id))
          .limit(1);
        return json(
          { data: { id: tx[0]?.id ?? existing.id, journalEntryId: existing.id, idempotentReplay: true } },
          { status: 200 }
        );
      }
    }
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}
