import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { stockAdjustments } from "@/db/schema";
import { ADJUSTMENT_REASONS } from "@/lib/stock-adjust";
import { postStockAdjustment } from "@/lib/stock-adjust";
import { parseQty } from "@/lib/qty";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

const qtyStr = z.string().regex(/^-?\d{1,12}(\.\d{1,3})?$/, "Invalid quantity");

const adjustmentSchema = z.object({
  reason: z.enum(ADJUSTMENT_REASONS),
  // Module 4.4: optional — when omitted, FOUND uses the system
  // Inventory Adjustment Gain account (4040) and all loss reasons use
  // Shrinkage Expense (6020).
  accountId: z.string().min(1).optional(),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  lines: z
    .array(
      z.object({
        productId: z.string().min(1),
        qtyMilli: qtyStr,
      })
    )
    .min(1, "Add at least one product line")
    .max(200),
});

// GET /api/stock-adjustments?page=&from=&to=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));
  const conds = [eq(stockAdjustments.companyId, companyId)];
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    try { conds.push(sql`${stockAdjustments.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${stockAdjustments.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select()
    .from(stockAdjustments)
    .where(and(...conds))
    .orderBy(desc(stockAdjustments.date), desc(stockAdjustments.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(stockAdjustments)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({
      ...r,
      date: (r.date as unknown as Date).getTime(),
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}

// POST /api/stock-adjustments — record a stock adjustment (G1)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = adjustmentSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  const date = parseDateOnly(b.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postStockAdjustment(tx, {
        companyId,
        branchId,
        reason: b.reason,
        accountId: b.accountId || undefined,
        date,
        lines: b.lines.map((l) => ({ productId: l.productId, qtyMilli: parseQty(l.qtyMilli) })),
        notes: b.notes || undefined,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "stock.adjustment.created", entity: "stock_adjustment", entityId: result.id,
      detail: `Stock adjustment ${result.docNo} (${b.reason})`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/stock-adjustments", companyId });
  }
}
