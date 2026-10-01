import { NextRequest } from "next/server";
import { eq, and, desc, ne, sql, getTableColumns } from "drizzle-orm";
import { parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/party-balances?kind=CUSTOMER&category= — receivables/payables list
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const kind = req.nextUrl.searchParams.get("kind") === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER";
  const category = req.nextUrl.searchParams.get("category")?.trim();

  const conds = [
    eq(parties.companyId, companyId),
    eq(parties.kind, kind),
    eq(parties.isActive, true),
    ne(parties.balance, 0n),
  ];
  // Raw SQL until the schema-fragment merge adds parties.category to the types.
  if (category) conds.push(sql`parties.category = ${category}`);

  const rows = await db
    .select({
      ...getTableColumns(parties),
      category: sql<string | null>`parties.category`,
    })
    .from(parties)
    .where(and(...conds))
    .orderBy(desc(parties.balance));

  const total = rows.reduce((a, p) => a + p.balance, 0n);
  return json({
    kind,
    data: rows.map((p) => ({
      id: p.id,
      name: p.name,
      phone: p.phone,
      city: p.city,
      category: p.category,
      balance: p.balance.toString(),
      creditLimit: p.creditLimit.toString(),
      // Module 23: credit-control status + auto-computed risk for the UI.
      creditStatus: p.creditStatus,
      creditHoldReason: p.creditHoldReason,
      riskCategory: p.riskCategory,
    })),
    total: total.toString(),
    count: rows.length,
  });
}
