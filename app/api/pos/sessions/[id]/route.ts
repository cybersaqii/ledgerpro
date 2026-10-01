import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { posSessions } from "@/db/schema";
import { computeSessionSummary } from "@/lib/pos-sessions";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { serializeSession } from "../route";

function serializeSummary(s: Awaited<ReturnType<typeof computeSessionSummary>>) {
  const b = (v: bigint) => v.toString();
  return {
    salesCount: s.salesCount,
    totalSalesPaisa: b(s.totalSalesPaisa),
    totalDiscountPaisa: b(s.totalDiscountPaisa),
    totalTaxPaisa: b(s.totalTaxPaisa),
    cashSalesPaisa: b(s.cashSalesPaisa),
    cardSalesPaisa: b(s.cardSalesPaisa),
    returnsCount: s.returnsCount,
    returnsTotalPaisa: b(s.returnsTotalPaisa),
    cashRefundsPaisa: b(s.cashRefundsPaisa),
    cashInPaisa: b(s.cashInPaisa),
    cashOutPaisa: b(s.cashOutPaisa),
    openingCashPaisa: b(s.openingCashPaisa),
    expectedCashPaisa: b(s.expectedCashPaisa),
  };
}

// GET /api/pos/sessions/[id] — shift detail. OPEN sessions get a live
// summary; CLOSED sessions return their stored snapshot.
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  try {
    const rows = await db
      .select()
      .from(posSessions)
      .where(and(eq(posSessions.id, id), eq(posSessions.companyId, companyId)))
      .limit(1);
    const s = rows[0];
    if (!s) return err("POS session not found.", 404);
    const summary =
      s.status === "OPEN"
        ? serializeSummary(await db.transaction((tx) => computeSessionSummary(tx, companyId, id)))
        : {
            salesCount: s.salesCount,
            totalSalesPaisa: (s.totalSalesPaisa ?? 0n).toString(),
            totalDiscountPaisa: (s.totalDiscountPaisa ?? 0n).toString(),
            totalTaxPaisa: (s.totalTaxPaisa ?? 0n).toString(),
            cashSalesPaisa: (s.cashSalesPaisa ?? 0n).toString(),
            cardSalesPaisa: (s.cardSalesPaisa ?? 0n).toString(),
            returnsCount: s.returnsCount,
            returnsTotalPaisa: (s.returnsTotalPaisa ?? 0n).toString(),
            cashRefundsPaisa: (s.cashRefundsPaisa ?? 0n).toString(),
            cashInPaisa: (s.cashInPaisa ?? 0n).toString(),
            cashOutPaisa: (s.cashOutPaisa ?? 0n).toString(),
            openingCashPaisa: (s.openingCashPaisa ?? 0n).toString(),
            expectedCashPaisa: (s.expectedCashPaisa ?? 0n).toString(),
          };
    return json({ data: { ...serializeSession(s), summary } });
  } catch (e) {
    return toApiError(e, { route: "/api/pos/sessions/[id]", companyId });
  }
}
