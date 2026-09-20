import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { products } from "@/db/schema";
import { getProductBatches } from "@/lib/batches";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/products/[id]/batches — batch rows for one product (FIFO order).
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const rows = await db
    .select({ id: products.id, name: products.name, unit: products.unit })
    .from(products)
    .where(and(eq(products.id, id), eq(products.companyId, companyId)))
    .limit(1);
  const p = rows[0];
  if (!p) return err("Not found.", 404);
  const batches = await getProductBatches(db, companyId, id);
  return json({
    data: batches.map((b) => ({
      id: b.id,
      batchNo: b.batchNo,
      expiryDate: b.expiryDate,
      qtyThousandths: b.qtyThousandths.toString(),
      productName: p.name,
      unit: p.unit,
    })),
  });
}
