import { NextRequest } from "next/server";
import { eq, and, desc, ne } from "drizzle-orm";
import { parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/party-balances?kind=CUSTOMER — receivables/payables list
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const kind = req.nextUrl.searchParams.get("kind") === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER";

  const rows = await db
    .select()
    .from(parties)
    .where(
      and(
        eq(parties.companyId, companyId),
        eq(parties.kind, kind),
        eq(parties.isActive, true),
        ne(parties.balance, 0n)
      )
    )
    .orderBy(desc(parties.balance));

  const total = rows.reduce((a, p) => a + p.balance, 0n);
  return json({
    kind,
    data: rows.map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      city: p.city,
      balance: p.balance.toString(),
      creditLimit: p.creditLimit.toString(),
    })),
    total: total.toString(),
    count: rows.length,
  });
}
