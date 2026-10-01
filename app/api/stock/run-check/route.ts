import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { toApiError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { runLowStockCheck } from "@/lib/low-stock";

// POST /api/stock/run-check — run the low-stock alert engine on demand.
// Permission "stock" (inventory users), unlike the cron route which is secret-secured.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  try {
    const result = await runLowStockCheck(db, gate.companyId);
    await logAudit(db, {
      companyId: gate.companyId,
      userId: gate.session.uid,
      userName: gate.session.name ?? "user",
      action: "stock.check.manual",
      detail: `low=${result.low} notified=${result.notified} deduped=${result.deduped}`,
      ip: clientIp(req),
    });
    return json({ data: result });
  } catch (e) {
    return toApiError(e, { route: "/api/stock/run-check", companyId: gate.companyId });
  }
}
