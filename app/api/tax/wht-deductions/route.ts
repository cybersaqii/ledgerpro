import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { listWhtDeductions } from "@/lib/tax";
import { fmtMoney } from "@/lib/format";

// GET /api/tax/wht-deductions — the WHT Deduction Register.
// Filters: from, to (YYYY-MM-DD), partyId, section, kind (BILL|PAYMENT|RECEIPT).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
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
  const { rows, total, totalWhtPaisa } = await listWhtDeductions(db, companyId, {
    from,
    to,
    partyId: sp.get("partyId") || undefined,
    section: sp.get("section") || undefined,
    kind: sp.get("kind") || undefined,
    page: parseInt(sp.get("page") || "1", 10),
    perPage: parseInt(sp.get("perPage") || "25", 10),
  });
  return json({
    // BigInt money columns are serialized as strings; fmt helpers included
    // for direct display.
    data: rows.map((r) => {
      const { grossPaisa, whtPaisa, ...rest } = r;
      return {
        ...rest,
        gross: grossPaisa.toString(),
        wht: whtPaisa.toString(),
        grossFmt: fmtMoney(grossPaisa),
        whtFmt: fmtMoney(whtPaisa),
      };
    }),
    total,
    totalWht: totalWhtPaisa.toString(),
    totalWhtFmt: fmtMoney(totalWhtPaisa),
  });
}
