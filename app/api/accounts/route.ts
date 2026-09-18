import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/accounts?type=EXPENSE — chart of accounts (for expense forms etc.)
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const type = req.nextUrl.searchParams.get("type");
  const conds = [eq(accounts.companyId, companyId), eq(accounts.isActive, true)];
  if (type) conds.push(eq(accounts.type, type));
  const rows = await db.select().from(accounts).where(and(...conds));
  return json({ data: rows });
}
