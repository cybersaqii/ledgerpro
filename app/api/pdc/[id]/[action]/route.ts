import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { payments, pdcCheques } from "@/db/schema";
import { pdcClearSchema, pdcReverseSchema } from "@/lib/validators";
import { clearPdc, bouncePdc, cancelPdc } from "@/lib/pdc";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import {
  extractIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

type Ctx = { params: Promise<{ id: string; action: string }> };

const PAST_TENSE: Record<string, string> = {
  clear: "cleared",
  bounce: "bounced",
  cancel: "cancelled",
};

// POST /api/pdc/[id]/clear — clear a pending PDC into a bank account
// POST /api/pdc/[id]/bounce — bounce a pending PDC (exact reversal)
// POST /api/pdc/[id]/cancel — cancel a pending PDC (exact reversal)
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id, action } = await ctx.params;

  if (action !== "clear" && action !== "bounce" && action !== "cancel") {
    return err("Unknown action.", 404);
  }

  // Module 17: idempotency on the money-moving actions (clear mints a
  // payment; bounce may carry a fee). Replays answer 200.
  // The body is read ONCE here and reused by every branch below.
  const rawBody: unknown = await req.json().catch(() => null);
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, rawBody);
  } catch (e) {
    return toApiError(e, { route: "/api/pdc/[id]/[action]", companyId });
  }
  async function findReplay() {
    if (!idemKey) return null;
    if (action === "clear") {
      const rows = await db
        .select({ id: payments.id, docNo: payments.docNo })
        .from(payments)
        .where(and(eq(payments.companyId, companyId), eq(payments.idempotencyKey, idemKey)))
        .limit(1);
      return rows[0] ? { paymentId: rows[0].id, docNo: rows[0].docNo } : null;
    }
    const rows = await db
      .select({ id: pdcCheques.id, status: pdcCheques.status })
      .from(pdcCheques)
      .where(and(eq(pdcCheques.companyId, companyId), eq(pdcCheques.id, id)))
      .limit(1);
    const st = rows[0]?.status;
    const want = action === "bounce" ? "BOUNCED" : "CANCELLED";
    return rows[0] && st === want ? { id: rows[0].id } : null;
  }
  const replay = await findReplay();
  if (replay)
    return json({ data: { id, ...replay, idempotentReplay: true } }, { status: 200 });
  const rl = await throttleMoneyCreate(db, "pdc-action", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  try {
    if (action === "clear") {
      const parsed = pdcClearSchema.safeParse(rawBody);
      if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
      const b = parsed.data;
      const date = parseDateOnly(b.date);
      const lockErr = await periodLockError(db, companyId, date);
      if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");
      let paymentId: string;
      try {
        paymentId = await db.transaction(async (tx) => {
          const branchId = b.branchId || (await defaultBranchId(tx, companyId));
          await assertBranch(tx, companyId, branchId);
          return clearPdc(tx, {
            pdcId: id, companyId, branchId,
            bankAccountId: b.bankAccountId, date, createdById: session.uid,
            idempotencyKey: idemKey,
          });
        });
      } catch (e) {
        if (idemKey && isIdempotencyConflict(e)) {
          const won = await findReplay();
          if (won) return json({ data: { id, ...won, idempotentReplay: true } }, { status: 200 });
        }
        throw e;
      }
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pdc.cleared", entity: "pdc", entityId: id,
        detail: `payment ${paymentId.slice(0, 8)}`,
      });
      return json({ data: { id, paymentId } });
    }

    const parsed = pdcReverseSchema.safeParse(rawBody ?? {});
    if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
    const b = parsed.data;
    const date = parseDateOnly(b.date);
    const lockErr = await periodLockError(db, companyId, date);
    if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");
    const bounceFee = b.bounceFee ? parseMoney(b.bounceFee) : 0n;
    await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      const input = {
        pdcId: id, companyId, branchId, date,
        createdById: session.uid, reason: b.reason || undefined,
        // Module 17: bounce fee is bounce-only (lib rejects it on cancel).
        bounceFee: action === "bounce" ? bounceFee : 0n,
      };
      if (action === "bounce") await bouncePdc(tx, input);
      else await cancelPdc(tx, input);
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `pdc.${PAST_TENSE[action]}`, entity: "pdc", entityId: id,
      detail: b.reason || "",
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/pdc/[id]/[action]", companyId });
  }
}
