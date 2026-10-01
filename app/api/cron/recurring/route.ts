import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError, reportError } from "@/lib/errors";
import { db } from "@/lib/route-helpers";
import { companies } from "@/db/schema";
import { verifyCronSecret, verifyCronToken } from "@/lib/backup";
import { runDueTemplates } from "@/lib/recurring";

// POST /api/cron/recurring — generate due recurring invoices for every company.
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
    const summary = { companies: rows.length, templates: 0, generated: 0, skipped: 0, failed: 0, failures: [] as { templateId: string; name: string; reason: string }[] };
    for (const c of rows) {
      try {
        const r = await runDueTemplates(db, { companyId: c.id });
        summary.templates += r.templates;
        summary.generated += r.generated;
        summary.skipped += r.skipped;
        summary.failed += r.failed;
        summary.failures.push(...r.failures);
      } catch (e) {
        summary.failed++;
        await reportError(
          { route: "/api/cron/recurring", message: e instanceof Error ? e.message : "Unknown", stack: e instanceof Error ? e.stack : undefined, companyId: c.id },
          db
        );
      }
    }
    return json({ data: summary });
  } catch (e) {
    return toApiError(e, { route: "/api/cron/recurring" });
  }
}
