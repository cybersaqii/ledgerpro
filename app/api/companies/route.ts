import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { companies, userCompanies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { getSession, createSession } from "@/lib/auth";
import { db } from "@/lib/route-helpers";
import { setupCompany } from "@/lib/setup";

// GET /api/companies — list companies this account can access.
export async function GET() {
  const session = await getSession();
  if (!session) return err("Please log in.", 401);
  const rows = await db
    .select({ id: companies.id, name: companies.name, role: userCompanies.role })
    .from(userCompanies)
    .innerJoin(companies, eq(userCompanies.companyId, companies.id))
    .where(and(eq(userCompanies.userId, session.uid), eq(userCompanies.isActive, true)));
  return json({ data: rows, currentId: session.cid });
}

// POST /api/companies — create a new company under this account.
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return err("Please log in.", 401);
  const body = await req.json().catch(() => null);
  const name = body?.name?.trim();
  if (!name || name.length > 120) return err("Company name is required.", 422);

  const companyId = crypto.randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name,
    email: body?.email?.trim() || null,
    phone: body?.phone?.trim() || null,
    address: body?.address?.trim() || null,
    city: body?.city?.trim() || null,
  });
  try {
    await setupCompany(db, companyId);
  } catch (e) {
    console.error("Company bootstrap failed", e);
    return err("Company setup hit a snag. Please try again.", 500);
  }
  await db.insert(userCompanies).values({
    id: crypto.randomUUID(),
    userId: session.uid,
    companyId,
    role: "OWNER",
    isActive: true,
  });
  // Switch the session to the new company immediately.
  await createSession({ ...session, cid: companyId, role: "OWNER" });
  return json({ data: { id: companyId, name } });
}
