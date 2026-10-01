import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { posSessions } from "@/db/schema";
import { posSessionOpenSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { openSession, type PosSession } from "@/lib/pos-sessions";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { extractIdempotencyKey, isIdempotencyConflict } from "@/lib/idempotency";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";

/** Serialize a session row; bigint paisa values go out as decimal strings. */
export function serializeSession(s: PosSession) {
  const b = (v: bigint | null | undefined) => (v ?? 0n).toString();
  return {
    id: s.id,
    branchId: s.branchId,
    terminalId: s.terminalId,
    terminalName: s.terminalName,
    cashAccountId: s.cashAccountId,
    status: s.status,
    openedById: s.openedById,
    openedAt: s.openedAt,
    openingCashPaisa: b(s.openingCashPaisa),
    closedById: s.closedById,
    closedAt: s.closedAt,
    countedCashPaisa: s.countedCashPaisa?.toString() ?? null,
    expectedCashPaisa: s.expectedCashPaisa?.toString() ?? null,
    variancePaisa: s.variancePaisa?.toString() ?? null,
    cashSalesPaisa: b(s.cashSalesPaisa),
    cardSalesPaisa: b(s.cardSalesPaisa),
    totalSalesPaisa: b(s.totalSalesPaisa),
    totalDiscountPaisa: b(s.totalDiscountPaisa),
    totalTaxPaisa: b(s.totalTaxPaisa),
    salesCount: s.salesCount,
    cashRefundsPaisa: b(s.cashRefundsPaisa),
    returnsCount: s.returnsCount,
    returnsTotalPaisa: b(s.returnsTotalPaisa),
    cashInPaisa: b(s.cashInPaisa),
    cashOutPaisa: b(s.cashOutPaisa),
    varianceEntryId: s.varianceEntryId,
    notes: s.notes,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

// GET /api/pos/sessions — recent shifts (?terminalId=, ?status=OPEN|CLOSED, ?limit=).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const q = new URL(req.url).searchParams;
  const terminalId = q.get("terminalId") || undefined;
  const status = q.get("status") === "OPEN" || q.get("status") === "CLOSED" ? q.get("status")! : undefined;
  const limit = Math.min(Math.max(parseInt(q.get("limit") || "20", 10) || 20, 1), 100);
  const conds = [eq(posSessions.companyId, companyId)];
  if (terminalId) conds.push(eq(posSessions.terminalId, terminalId));
  if (status) conds.push(eq(posSessions.status, status));
  const rows = await db
    .select()
    .from(posSessions)
    .where(and(...conds))
    .orderBy(desc(posSessions.openedAt))
    .limit(limit);
  return json({ data: rows.map(serializeSession) });
}

// POST /api/pos/sessions — open a register shift.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const body = await req.json().catch(() => null);
  const parsed = posSessionOpenSchema.safeParse(body);
  if (!parsed.success) return err("Please check the shift details and try again.", 422);
  const b = parsed.data;

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions", companyId });
  }

  try {
    const { session: s, idempotentReplay } = await db.transaction((tx) =>
      openSession(tx, {
        companyId,
        terminalId: b.terminalId,
        openingCashPaisa: parseMoney(b.openingCash),
        notes: b.notes || undefined,
        createdById: session.uid,
        idempotencyKey: idemKey,
      })
    );
    if (!idempotentReplay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pos.session_opened", entity: "pos_session", entityId: s.id,
        detail: `Shift opened on ${s.terminalName}`,
      });
    }
    return json(
      { data: { ...serializeSession(s), idempotentReplay } },
      { status: idempotentReplay ? 200 : 201 }
    );
  } catch (e) {
    // Lost the idempotency race: the other request's session already exists.
    if (idemKey && isIdempotencyConflict(e)) {
      const prior = await db
        .select()
        .from(posSessions)
        .where(and(eq(posSessions.companyId, companyId), eq(posSessions.idempotencyKey, idemKey)))
        .limit(1);
      if (prior[0])
        return json({ data: { ...serializeSession(prior[0]), idempotentReplay: true } }, { status: 200 });
    }
    return toApiError(e, { route: "/api/pos/sessions", companyId });
  }
}
