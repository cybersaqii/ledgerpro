import { NextRequest } from "next/server";
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { whtDeductions, parties } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";

// GET /api/reports/wht-deductions
// WHT Deductions Register as a standalone report.
// Filters: from, to (YYYY-MM-DD), partyType (CUSTOMER|SUPPLIER|ALL), section.
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
  const partyType = sp.get("partyType") || "ALL";
  const section = sp.get("section") || "";

  const conds = [
    eq(whtDeductions.companyId, companyId),
    sql`${whtDeductions.voidedAt} IS NULL`,
  ];
  if (from) conds.push(gte(whtDeductions.date, from));
  if (to) {
    const end = new Date(to.getTime() + 86400000);
    conds.push(lt(whtDeductions.date, end));
  }
  if (section) conds.push(eq(whtDeductions.taxSection, section));
  if (partyType === "CUSTOMER" || partyType === "SUPPLIER") {
    conds.push(eq(parties.kind, partyType));
  }

  const rows = await db
    .select({
      id: whtDeductions.id,
      date: whtDeductions.date,
      kind: whtDeductions.kind,
      taxSection: whtDeductions.taxSection,
      rateBps: whtDeductions.rateBps,
      grossPaisa: whtDeductions.grossPaisa,
      whtPaisa: whtDeductions.whtPaisa,
      deducteeName: whtDeductions.deducteeName,
      ntnCnic: whtDeductions.ntnCnic,
      cprNo: whtDeductions.cprNo,
      depositedAt: whtDeductions.depositedAt,
      partyKind: parties.kind,
    })
    .from(whtDeductions)
    .leftJoin(parties, eq(whtDeductions.partyId, parties.id))
    .where(and(...conds))
    .orderBy(whtDeductions.date);

  let totalGross = 0n;
  let totalWht = 0n;
  const data = rows.map((r) => {
    const gross = BigInt(r.grossPaisa ?? "0");
    const wht = BigInt(r.whtPaisa ?? "0");
    totalGross += gross;
    totalWht += wht;
    return {
      id: r.id,
      date: (r.date as unknown as Date).getTime(),
      kind: r.kind,
      taxSection: r.taxSection,
      rateBps: r.rateBps,
      ratePct: (r.rateBps / 100).toFixed(2),
      gross: gross.toString(),
      wht: wht.toString(),
      party: r.deducteeName,
      ntnCnic: r.ntnCnic,
      partyKind: r.partyKind,
      deposited: !!r.depositedAt,
      cprNo: r.cprNo,
    };
  });

  return json({
    data,
    totals: {
      count: data.length,
      gross: totalGross.toString(),
      wht: totalWht.toString(),
    },
  });
}
