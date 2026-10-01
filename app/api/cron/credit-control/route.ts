import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { toApiError, reportError } from "@/lib/errors";
import { db } from "@/lib/route-helpers";
import { companies, parties } from "@/db/schema";
import { verifyCronSecret, verifyCronToken } from "@/lib/backup";
import { evaluateCreditHold } from "@/lib/credit-control";

// POST /api/cron/credit-control — nightly credit-hold sweep for every company.
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
    const summary = { companies: rows.length, evaluated: 0, held: 0, failed: 0 };
    for (const c of rows) {
      try {
        const customers = await db
          .select({ id: parties.id })
          .from(parties)
          .where(
            and(
              eq(parties.companyId, c.id),
              eq(parties.kind, "CUSTOMER"),
              eq(parties.isActive, true)
            )
          );
        for (const cu of customers) {
          const d = await db.transaction((tx) =>
            evaluateCreditHold(tx, { companyId: c.id, partyId: cu.id, actor: "SYSTEM" })
          );
          summary.evaluated++;
          if (d.held) summary.held++;
        }
      } catch (e) {
        summary.failed++;
        await reportError(
          { route: "/api/cron/credit-control", message: e instanceof Error ? e.message : "Unknown", stack: e instanceof Error ? e.stack : undefined, companyId: c.id },
          db
        );
      }
    }
    return json({ data: summary });
  } catch (e) {
    return toApiError(e, { route: "/api/cron/credit-control" });
  }
}
