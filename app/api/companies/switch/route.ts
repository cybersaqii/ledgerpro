import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { userCompanies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { getSession, createSession } from "@/lib/auth";
import { db } from "@/lib/route-helpers";

// POST /api/companies/switch — switch the session to another of the user's companies.
// Tenant isolation is preserved: every API reads companyId from the session.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return err("Please log in.", 401);
  const body = await req.json().catch(() => null);
  const companyId = body?.companyId;
  if (typeof companyId !== "string" || !companyId) return err("Company is required.", 422);

  const rows = await db
    .select()
    .from(userCompanies)
    .where(
      and(
        eq(userCompanies.userId, session.uid),
        eq(userCompanies.companyId, companyId),
        eq(userCompanies.isActive, true)
      )
    )
    .limit(1);
  if (rows.length === 0) return err("You do not have access to this company.", 403);

  await createSession({ ...session, cid: companyId, role: rows[0].role });
  return json({ ok: true, companyId });
}
