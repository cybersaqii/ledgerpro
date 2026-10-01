import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError, reportError } from "@/lib/errors";
import { db } from "@/lib/route-helpers";
import { companies } from "@/db/schema";
import { verifyCronSecret, verifyCronToken } from "@/lib/backup";
import { runLowStockCheck } from "@/lib/low-stock";

// POST /api/cron/low-stock — daily low-stock alert sweep for every company.
// Same dual auth as /api/cron/backup:
//   1. Authorization: Bearer <CRON_SECRET> (humans / scripts — preferred)
//   2. ?token=<cron-token>                  (Vercel Cron — cannot send headers)
export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const headerOk = expected ? verifyCronSecret(bearer, expected) : false;
  const tokenOk = await verifyCronToken(db, req.nextUrl.searchParams.get("token")).catch(() => false);
  if (!headerOk && !tokenOk) {
    return err("Not authorized.", 401);
  }
  try {
    const rows = await db.select({ id: companies.id }).from(companies);
    const summary = { companies: rows.length, notified: 0, emailSent: 0, failed: 0 };
    for (const c of rows) {
      try {
        const r = await runLowStockCheck(db, c.id);
        summary.notified += r.notified;
        summary.emailSent += r.emailSent;
      } catch (e) {
        summary.failed++;
        await reportError(
          { route: "/api/cron/low-stock", message: e instanceof Error ? e.message : "Unknown", stack: e instanceof Error ? e.stack : undefined, companyId: c.id },
          db
        );
      }
    }
    return json({ data: summary });
  } catch (e) {
    return toApiError(e, { route: "/api/cron/low-stock" });
  }
}
