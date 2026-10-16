import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { projects } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { projectPL } from "@/lib/projects";

// GET /api/reports/budget-vs-actual?from=&to=
// Project Budget vs Actual: per project — budgeted cost vs actual cost
// (from project-tagged journal lines), variance, variance %, plus
// contract value vs actual revenue. Budgets in LedgerPro live on projects
// (Module 13: Projects & Job Costing); there is no GL-account budget.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const fromStr = sp.get("from");
  const toStr = sp.get("to");

  let from: Date | null = null;
  let to: Date | null = null;
  if (fromStr) {
    const t = Date.parse(`${fromStr}T00:00:00Z`);
    if (!isNaN(t)) from = new Date(t);
  }
  if (toStr) {
    const t = Date.parse(`${toStr}T00:00:00Z`);
    if (!isNaN(t)) to = new Date(t + 86400000 - 1);
  }

  const list = await db
    .select({
      id: projects.id,
      code: projects.code,
      name: projects.name,
      status: projects.status,
      contractValue: projects.contractValue,
      budget: projects.budget,
    })
    .from(projects)
    .where(eq(projects.companyId, companyId))
    .orderBy(projects.code);

  const s = (v: bigint) => v.toString();
  const items: {
    id: string; code: string; name: string; status: string;
    contractValue: string; budget: string; revenue: string;
    actualCost: string; variance: string; variancePct: string | null;
  }[] = [];

  let totalBudget = 0n;
  let totalCost = 0n;
  let totalRevenue = 0n;

  for (const p of list) {
    const pl = await projectPL(db, companyId, p.id, from, to);
    const budget = p.budget as bigint;
    const variance = budget - pl.cost;
    // Variance % of budget; null when no budget set.
    const variancePct = budget > 0n ? (Number(variance * 10000n / budget) / 100).toFixed(1) : null;
    items.push({
      id: p.id,
      code: p.code,
      name: p.name,
      status: p.status,
      contractValue: s(p.contractValue as bigint),
      budget: s(budget),
      revenue: s(pl.revenue),
      actualCost: s(pl.cost),
      variance: s(variance),
      variancePct,
    });
    totalBudget += budget;
    totalCost += pl.cost;
    totalRevenue += pl.revenue;
  }

  const totalVariancePct = totalBudget > 0n
    ? (Number((totalBudget - totalCost) * 10000n / totalBudget) / 100).toFixed(1)
    : null;

  return json({
    items,
    count: items.length,
    totals: {
      budget: s(totalBudget),
      actualCost: s(totalCost),
      variance: s(totalBudget - totalCost),
      variancePct: totalVariancePct,
      contractValue: s(list.reduce((a, p) => a + (p.contractValue as bigint), 0n)),
      revenue: s(totalRevenue),
    },
    from: fromStr,
    to: toStr,
  });
}
