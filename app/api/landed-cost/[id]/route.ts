import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { landedCostSheets, landedCostHeads, landedCostLines, products, purchaseDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

type Ctx = { params: Promise<{ id: string }> };

// GET /api/landed-cost/[id] — sheet detail with heads + per-product lines.
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;

  const rows = await db
    .select()
    .from(landedCostSheets)
    .where(and(eq(landedCostSheets.id, id), eq(landedCostSheets.companyId, companyId)))
    .limit(1);
  const sheet = rows[0];
  if (!sheet) return err("Landed-cost sheet not found.", 404);

  const heads = await db
    .select()
    .from(landedCostHeads)
    .where(eq(landedCostHeads.sheetId, sheet.id));
  const lineRows = await db
    .select({ l: landedCostLines, name: products.name, sku: products.sku, unit: products.unit })
    .from(landedCostLines)
    .leftJoin(products, eq(landedCostLines.productId, products.id))
    .where(eq(landedCostLines.sheetId, sheet.id));
  let docNo: string | null = null;
  if (sheet.purchaseDocId) {
    const d = await db
      .select({ docNo: purchaseDocs.docNo, docType: purchaseDocs.docType })
      .from(purchaseDocs)
      .where(eq(purchaseDocs.id, sheet.purchaseDocId))
      .limit(1);
    docNo = d[0] ? `${d[0].docType} ${d[0].docNo}` : null;
  }

  return json({
    data: {
      ...sheet,
      docLabel: docNo,
      heads: heads.map((h) => ({ ...h, amountPaisa: h.amountPaisa.toString() })),
      lines: lineRows.map((r) => ({
        ...r.l,
        qtyMilli: r.l.qtyMilli.toString(),
        valuePaisa: r.l.valuePaisa.toString(),
        weightScaled: r.l.weightScaled.toString(),
        allocatedPaisa: r.l.allocatedPaisa.toString(),
        productName: r.name,
        sku: r.sku,
        unit: r.unit,
      })),
      totalPaisa: sheet.totalPaisa.toString(),
    },
  });
}
