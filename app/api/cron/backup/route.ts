import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { backupAllCompanies, verifyCronSecret, verifyCronToken } from "@/lib/backup";

// POST /api/cron/backup — scheduled automatic backup of every company.
// No login session. Two auth paths (either one suffices, both constant-time):
//   1. Authorization: Bearer <CRON_SECRET>   (humans / scripts — preferred)
//   2. ?token=<cron-token>                    (Vercel Cron — cannot send headers)
//
// The cron token is single-purpose and revocable (minted in the admin UI);
// the raw CRON_SECRET is NEVER accepted as a query parameter, so it cannot
// leak into server/proxy logs. 401 without a valid credential, 503 when the
// server is not configured for automatic backups.
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
    const summary = await backupAllCompanies(db);
    return json({ data: summary });
  } catch (e) {
    return toApiError(e, { route: "/api/cron/backup" });
  }
}
