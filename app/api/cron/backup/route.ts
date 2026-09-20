import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { db } from "@/lib/db";
import { backupAllCompanies, verifyCronSecret } from "@/lib/backup";

// POST /api/cron/backup — scheduled automatic backup of every company.
// No login session: guarded by CRON_SECRET instead. Vercel Cron cannot send
// custom headers, so the secret is accepted as a Bearer token OR as the
// `secret` query parameter (both constant-time compared). 401 without it.
export async function POST(req: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (!expected) return err("Automatic backups are not configured on this server.", 503);
  const auth = req.headers.get("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  const param = req.nextUrl.searchParams.get("secret");
  if (!verifyCronSecret(bearer, expected) && !verifyCronSecret(param, expected)) {
    return err("Not authorized.", 401);
  }
  try {
    const summary = await backupAllCompanies(db);
    return json({ data: summary });
  } catch (e) {
    return toApiError(e, { route: "/api/cron/backup" });
  }
}
