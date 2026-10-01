import { asc, desc, eq } from "drizzle-orm";
import { json } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { branches } from "@/db/schema";

// GET /api/branches — id + name of the company's branches (default first),
// used by branch pickers (e.g. the stock-transfer dialog).
export async function GET() {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const rows = await db
    .select({ id: branches.id, name: branches.name, isDefault: branches.isDefault })
    .from(branches)
    .where(eq(branches.companyId, auth.companyId))
    .orderBy(desc(branches.isDefault), asc(branches.name));
  return json({ data: rows.map((r) => ({ id: r.id, name: r.name, isDefault: !!r.isDefault })) });
}
