import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and, desc } from "drizzle-orm";
import { stockTransferDocs, stockTransferLines, branches, products } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseQty } from "@/lib/qty";
import { createStockTransfer } from "@/lib/inventory";

const lineSchema = z.object({
  productId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

const createSchema = z.object({
  fromBranchId: z.string().min(1),
  toBranchId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  lines: z.array(lineSchema).min(1).max(200),
  idempotencyKey: z.string().trim().max(40).optional().or(z.literal("")),
});

async function docWithLines(companyId: string, id: string) {
  const docs = await db
    .select()
    .from(stockTransferDocs)
    .where(and(eq(stockTransferDocs.id, id), eq(stockTransferDocs.companyId, companyId)))
    .limit(1);
  const doc = docs[0];
  if (!doc) return null;
  const lines = await db
    .select({ l: stockTransferLines, productName: products.name, productUnit: products.unit, productSku: products.sku })
    .from(stockTransferLines)
    .leftJoin(products, eq(products.id, stockTransferLines.productId))
    .where(eq(stockTransferLines.transferId, id));
  const br = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(and(eq(branches.companyId, companyId)));
  const nameOf = new Map(br.map((b) => [b.id, b.name]));
  return {
    ...doc,
    date: doc.date ? new Date(Number(doc.date)).toISOString() : null,
    fromBranchName: nameOf.get(doc.fromBranchId) ?? null,
    toBranchName: nameOf.get(doc.toBranchId) ?? null,
    lines: lines.map((r) => ({
      id: r.l.id,
      productId: r.l.productId,
      productName: r.productName,
      productSku: r.productSku,
      unit: r.productUnit,
      qtyMilli: r.l.qtyMilli.toString(),
      costPaisa: r.l.costPaisa.toString(),
    })),
  };
}

// GET /api/stock/transfer-docs?status= — list transfer documents (newest first).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const status = req.nextUrl.searchParams.get("status")?.trim() || "";
  const conds = [eq(stockTransferDocs.companyId, companyId)];
  if (["DRAFT", "IN_TRANSIT", "RECEIVED", "CANCELLED"].includes(status)) {
    conds.push(eq(stockTransferDocs.status, status));
  }
  const docs = await db
    .select()
    .from(stockTransferDocs)
    .where(and(...conds))
    .orderBy(desc(stockTransferDocs.createdAt))
    .limit(100);
  const br = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(eq(branches.companyId, companyId));
  const nameOf = new Map(br.map((b) => [b.id, b.name]));
  return json({
    data: docs.map((d) => ({
      id: d.id,
      docNo: d.docNo,
      date: d.date ? new Date(Number(d.date)).toISOString() : null,
      status: d.status,
      fromBranchId: d.fromBranchId,
      toBranchId: d.toBranchId,
      fromBranchName: nameOf.get(d.fromBranchId) ?? null,
      toBranchName: nameOf.get(d.toBranchId) ?? null,
      notes: d.notes,
    })),
  });
}

// POST /api/stock/transfer-docs — create a DRAFT transfer document (no stock moves yet).
export async function POST(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;

  const body = await req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
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
    const result = await db.transaction((tx) =>
      createStockTransfer(tx, {
        companyId,
        fromBranchId: b.fromBranchId,
        toBranchId: b.toBranchId,
        date,
        notes: b.notes || undefined,
        createdById: session.uid,
        lines: b.lines.map((l) => ({ productId: l.productId, qtyMilli: parseQty(l.qty) })),
        idempotencyKey: b.idempotencyKey || undefined,
      })
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "stock.transfer_created",
      entity: "stock_transfer",
      entityId: result.id,
      detail: `Transfer ${result.docNo} drafted (${b.lines.length} item${b.lines.length === 1 ? "" : "s"})`,
    });
    return json({ data: await docWithLines(companyId, result.id) }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/stock/transfer-docs", companyId });
  }
}

export { docWithLines };
