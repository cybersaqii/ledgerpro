import { NextRequest, NextResponse } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { annexureCRows } from "@/lib/tax";
import { rowsToCsv, csvMoney } from "@/lib/csv";
import { fmtMoney } from "@/lib/format";

// GET /api/tax/annexure-c?from=&to= — Annexure C (output tax) from sales invoices.
// ?format=csv returns an e-filing-friendly CSV download.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_accounting");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  let from: Date;
  let to: Date;
  try {
    from = parseDateOnly(sp.get("from") || new Date().toISOString().slice(0, 7) + "-01");
    const toStr = sp.get("to");
    to = toStr ? parseDateOnly(toStr) : new Date();
  } catch {
    return err("Invalid date range.", 422);
  }
  const rows = await annexureCRows(db, companyId, from, to);
  if (sp.get("format") === "csv") {
    const csv = rowsToCsv(
      ["Buyer NTN", "Buyer Name", "Document Type", "Document No", "Date", "Rate %", "Sales Value (Excl. Tax)", "Sales Tax"],
      rows.map((r) => [
        r.buyerNtn ?? "",
        r.buyerName,
        r.docType,
        r.docNo,
        r.date.toISOString().slice(0, 10),
        (r.rateBps / 100).toString(),
        csvMoney(r.salesValuePaisa),
        csvMoney(r.taxPaisa),
      ])
    );
    const stamp = `${from.toISOString().slice(0, 10)}_to_${to.toISOString().slice(0, 10)}`;
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="annexure-c_${stamp}.csv"`,
      },
    });
  }
  const totalValue = rows.reduce((a, r) => a + r.salesValuePaisa, 0n);
  const totalTax = rows.reduce((a, r) => a + r.taxPaisa, 0n);
  return json({
    data: rows.map((r) => {
      const { salesValuePaisa, taxPaisa, ...rest } = r;
      return {
        ...rest,
        date: r.date.toISOString().slice(0, 10),
        salesValue: salesValuePaisa.toString(),
        tax: taxPaisa.toString(),
        salesValueFmt: fmtMoney(salesValuePaisa),
        taxFmt: fmtMoney(taxPaisa),
      };
    }),
    totalValue: totalValue.toString(),
    totalTax: totalTax.toString(),
    totalValueFmt: fmtMoney(totalValue),
    totalTaxFmt: fmtMoney(totalTax),
  });
}
