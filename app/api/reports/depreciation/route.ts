import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { depreciationRuns, depreciationEntries } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/reports/depreciation?from=&to=
// Depreciation report: per asset per posted run period — opening NBV,
// depreciation charge, closing NBV — with period and grand totals.
// Only POSTED runs count (draft/voided runs are excluded).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from");
  const to = sp.get("to");

  const conds = [
    eq(depreciationRuns.companyId, companyId),
    eq(depreciationRuns.status, "POSTED"),
  ];
  if (from) {
    const [y, m] = from.split("-").map(Number);
    if (y && m) conds.push(sql`(${depreciationRuns.year} * 100 + ${depreciationRuns.month}) >= ${y * 100 + m}`);
  }
  if (to) {
    const [y, m] = to.split("-").map(Number);
    if (y && m) conds.push(sql`(${depreciationRuns.year} * 100 + ${depreciationRuns.month}) <= ${y * 100 + m}`);
  }

  const rows = await db
    .select({
      runId: depreciationRuns.id,
      year: depreciationRuns.year,
      month: depreciationRuns.month,
      runDate: depreciationRuns.runDate,
      assetId: depreciationEntries.assetId,
      assetCode: depreciationEntries.assetCode,
      assetDescription: depreciationEntries.assetDescription,
      depreciationPaisa: depreciationEntries.depreciationPaisa,
      nbvBeforePaisa: depreciationEntries.nbvBeforePaisa,
      nbvAfterPaisa: depreciationEntries.nbvAfterPaisa,
    })
    .from(depreciationEntries)
    .innerJoin(depreciationRuns, eq(depreciationEntries.runId, depreciationRuns.id))
    .where(and(...conds))
    .orderBy(depreciationRuns.year, depreciationRuns.month, depreciationEntries.assetCode);

  const s = (v: bigint) => v.toString();
  type Period = {
    key: string; label: string;
    rows: { assetId: string; assetCode: string; assetDescription: string; opening: string; charge: string; closing: string }[];
    totalCharge: bigint;
  };
  const byPeriod = new Map<string, Period>();
  let grandCharge = 0n;
  let grandOpening = 0n;
  let grandClosing = 0n;

  for (const r of rows) {
    const key = `${r.year}-${String(r.month).padStart(2, "0")}`;
    let p = byPeriod.get(key);
    if (!p) {
      p = { key, label: key, rows: [], totalCharge: 0n };
      byPeriod.set(key, p);
    }
    const charge = r.depreciationPaisa as bigint;
    const opening = r.nbvBeforePaisa as bigint;
    const closing = r.nbvAfterPaisa as bigint;
    p.rows.push({
      assetId: r.assetId,
      assetCode: r.assetCode,
      assetDescription: r.assetDescription,
      opening: s(opening),
      charge: s(charge),
      closing: s(closing),
    });
    p.totalCharge += charge;
    grandCharge += charge;
    grandOpening += opening;
    grandClosing += closing;
  }

  return json({
    periods: [...byPeriod.values()].map((p) => ({
      key: p.key,
      label: p.label,
      rows: p.rows,
      totalCharge: s(p.totalCharge),
    })),
    totals: {
      charge: s(grandCharge),
      opening: s(grandOpening),
      closing: s(grandClosing),
    },
    from,
    to,
  });
}
