import { NextRequest } from "next/server";
import { posSessionCloseSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { closeSession } from "@/lib/pos-sessions";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { extractIdempotencyKey } from "@/lib/idempotency";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";
import { serializeSession } from "../../route";

// POST /api/pos/sessions/[id]/close — close the shift with a cash count.
// Computes the live summary, posts a balanced variance journal when counted
// ≠ expected, and stores the snapshot. Idempotent: re-closing a CLOSED
// session replays its snapshot without posting a second journal.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = posSessionCloseSchema.safeParse(body);
  if (!parsed.success) return err("Please enter the counted cash and try again.", 422);
  const b = parsed.data;

  try {
    extractIdempotencyKey(req, body); // validated for shape; the close itself is idempotent via status
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]/close", companyId });
  }

  try {
    const result = await db.transaction((tx) =>
      closeSession(tx, {
        companyId,
        sessionId: id,
        countedCashPaisa: parseMoney(b.countedCash),
        notes: b.notes || undefined,
        closedById: session.uid,
      })
    );
    if (!result.idempotentReplay) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pos.session_closed", entity: "pos_session", entityId: id,
        detail: `Shift closed on ${result.session.terminalName} — variance ${result.variancePaisa}`,
      });
    }
    const s = result.summary;
    return json({
      data: {
        ...serializeSession(result.session),
        summary: {
          salesCount: s.salesCount,
          totalSalesPaisa: s.totalSalesPaisa.toString(),
          totalDiscountPaisa: s.totalDiscountPaisa.toString(),
          totalTaxPaisa: s.totalTaxPaisa.toString(),
          cashSalesPaisa: s.cashSalesPaisa.toString(),
          cardSalesPaisa: s.cardSalesPaisa.toString(),
          returnsCount: s.returnsCount,
          returnsTotalPaisa: s.returnsTotalPaisa.toString(),
          cashRefundsPaisa: s.cashRefundsPaisa.toString(),
          cashInPaisa: s.cashInPaisa.toString(),
          cashOutPaisa: s.cashOutPaisa.toString(),
          openingCashPaisa: s.openingCashPaisa.toString(),
          expectedCashPaisa: s.expectedCashPaisa.toString(),
        },
        countedCashPaisa: result.countedCashPaisa.toString(),
        expectedCashPaisa: result.expectedCashPaisa.toString(),
        variancePaisa: result.variancePaisa.toString(),
        varianceEntryId: result.varianceEntryId,
        idempotentReplay: result.idempotentReplay,
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]/close", companyId });
  }
}
