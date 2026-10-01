import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { products } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, defaultBranchId, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseQty } from "@/lib/qty";
import { parseMoney } from "@/lib/money";
import { postOpeningStock } from "@/lib/inventory";
import { fmtQty } from "@/lib/format";

const openingSchema = z.object({
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
  cost: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid cost"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  branchId: z.string().min(1).max(40).optional(),
});

// POST /api/products/[id]/opening-stock — post opening stock once per product:
//   Dr Inventory (product's inventory account, else 1200)
//   Cr Opening Balance Equity (3002)
// Guarded by products.opening_stock_posted: a second call returns 409
// ALREADY_POSTED (the natural idempotency for this money POST).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = openingSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch {
    return err("Date is invalid.", 422);
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      return postOpeningStock(tx, {
        companyId,
        branchId,
        productId: id,
        qtyMilli: parseQty(b.qty),
        unitCostPaisa: parseMoney(b.cost),
        date,
        createdById: session.uid,
      });
    });
    const rows = await db
      .select({ name: products.name, unit: products.unit })
      .from(products)
      .where(and(eq(products.id, id), eq(products.companyId, companyId)))
      .limit(1);
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "product.opening_stock",
      entity: "product",
      entityId: id,
      detail: `Opening stock posted for "${rows[0]?.name ?? id}": ${fmtQty(parseQty(b.qty), rows[0]?.unit ?? "")} @ ${b.cost}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/products/[id]/opening-stock", companyId });
  }
}
