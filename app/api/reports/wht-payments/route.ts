import { NextRequest } from "next/server";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { whtDeductions } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";

// GET /api/reports/wht-payments
// WHT deposited/paid to FBR — deductions that have a deposit date (depositedAt)
// and/or a CPR/challan number. Filters: from, to (YYYY-MM-DD) on deposit date,
// section.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;

  let from: Date | undefined;
  let to: Date | undefined;
  try {
    if (sp.get("from")) from = parseDateOnly(sp.get("from")!);
    if (sp.get("to")) to = parseDateOnly(sp.get("to")!);
  } catch {
    /* ignore bad dates */
  }
  const section = sp.get("section") || "";

  const conds = [
    eq(whtDeductions.companyId, companyId),
    sql`${whtDeductions.voidedAt} IS NULL`,
    sql`${whtDeductions.depositedAt} IS NOT NULL`,
  ];
  if (from) conds.push(gte(whtDeductions.depositedAt, from));
  if (to) {
    const end = new Date(to.getTime() + 86400000);
    conds.push(lt(whtDeductions.depositedAt, end));
  }
  if (section) conds.push(eq(whtDeductions.taxSection, section));

  const rows = await db
    .select({
      id: whtDeductions.id,
      date: whtDeductions.date,
      depositedAt: whtDeductions.depositedAt,
      taxSection: whtDeductions.taxSection,
      rateBps: whtDeductions.rateBps,
      grossPaisa: whtDeductions.grossPaisa,
      whtPaisa: whtDeductions.whtPaisa,
      deducteeName: whtDeductions.deducteeName,
      cprNo: whtDeductions.cprNo,
    })
    .from(whtDeductions)
    .where(and(...conds))
    .orderBy(whtDeductions.depositedAt);

  let totalWht = 0n;
  const data = rows.map((r) => {
    const wht = BigInt(r.whtPaisa ?? "0");
    totalWht += wht;
    return {
      id: r.id,
      deductionDate: (r.date as unknown as Date).getTime(),
      depositedAt: r.depositedAt ? (r.depositedAt as unknown as Date).getTime() : null,
      taxSection: r.taxSection,
      ratePct: (r.rateBps / 100).toFixed(2),
      gross: BigInt(r.grossPaisa ?? "0").toString(),
      wht: wht.toString(),
      party: r.deducteeName,
      cprNo: r.cprNo,
    };
  });

  return json({
    data,
    totals: { count: data.length, wht: totalWht.toString() },
  });
}
