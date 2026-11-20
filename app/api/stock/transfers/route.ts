import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { branches, products, stockLevels, stockTransferDocs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { toApiError } from "@/lib/errors";
import { parseQty, formatQty } from "@/lib/qty";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
} from "@/lib/idempotency";
import {
  createStockTransfer,
  issueStockTransfer,
  receiveStockTransfer,
} from "@/lib/inventory";

const transferSchema = z.object({
  productId: z.string().min(1),
  fromBranchId: z.string().min(1),
  toBranchId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/stock/transfers — quick single-product transfer between two
// branches of the company. Runs on the Module 4 transfer-document flow:
// creates a draft, issues it (source deducted at average cost) and receives
// it immediately (destination added at the captured cost), so the movement
// ledger records both legs. No value / P&L impact: the moved quantity
// carries the source branch's moving-average cost into the destination.
// Validated (422): qty > 0, from != to, both branches belong to the company,
// tracked product with sufficient source stock, date valid and in an open period.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;

  const body = await req.json().catch(() => null);
  const parsed = transferSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const qtyMilli = parseQty(b.qty);
  if (qtyMilli <= 0n) return err("Transfer quantity must be positive.", 422);

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch {
    return err("Date is invalid.", 422);
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  // Phase 1: a retry of the same submission returns the already-completed
  // transfer with 200 instead of moving the stock a second time. The
  // pre-check must happen here (not only inside createStockTransfer):
  // a replayed create would return a RECEIVED doc that issueStockTransfer
  // would reject as "not a draft".
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/stock/transfers", companyId });
  }
  const buildResponse = async (transferId: string, docNo: string) => {
    const [prod] = await db
      .select({ name: products.name, unit: products.unit })
      .from(products)
      .where(and(eq(products.id, b.productId), eq(products.companyId, companyId)))
      .limit(1);
    const br = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(eq(branches.companyId, companyId));
    const nameOf = new Map(br.map((x) => [x.id, x.name]));
    const lv = await db
      .select()
      .from(stockLevels)
      .where(eq(stockLevels.productId, b.productId));
    const qtyOf = (branchId: string) =>
      lv.find((l) => l.branchId === branchId)?.qty ?? 0n;
    return {
      transferId,
      docNo,
      productId: b.productId,
      productName: prod?.name ?? b.productId,
      productUnit: prod?.unit ?? "",
      fromBranchId: b.fromBranchId,
      toBranchId: b.toBranchId,
      fromBranchName: nameOf.get(b.fromBranchId) ?? b.fromBranchId,
      toBranchName: nameOf.get(b.toBranchId) ?? b.toBranchId,
      qtyMilli: qtyMilli.toString(),
      fromQtyMilli: qtyOf(b.fromBranchId).toString(),
      toQtyMilli: qtyOf(b.toBranchId).toString(),
    };
  };
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, stockTransferDocs, companyId, idemKey);
    if (existing)
      return json(
        { data: { ...(await buildResponse(existing.id, existing.docNo!)), idempotentReplay: true } },
        { status: 200 }
      );
  }

  try {
    const result = await db.transaction(async (tx) => {
      const { id, docNo } = await createStockTransfer(tx, {
        companyId,
        fromBranchId: b.fromBranchId,
        toBranchId: b.toBranchId,
        date,
        notes: b.notes || undefined,
        createdById: session.uid,
        lines: [{ productId: b.productId, qtyMilli }],
        idempotencyKey: idemKey,
      });
      await issueStockTransfer(tx, companyId, id);
      await receiveStockTransfer(tx, companyId, id);
      return { id, docNo };
    });

    const resp = await buildResponse(result.id, result.docNo);
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "stock.transferred",
      entity: "stock",
      entityId: result.id,
      detail: `Moved ${formatQty(qtyMilli)} ${resp.productUnit} of ${resp.productName} from ${resp.fromBranchName} to ${resp.toBranchName} (${result.docNo})${
        b.notes ? ` — ${b.notes}` : ""
      }`,
    });
    return json({ data: resp }, { status: 201 });
  } catch (e) {
    // Lost the idempotency race: a concurrent request already completed
    // the transfer for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, stockTransferDocs, companyId, idemKey);
      if (existing)
        return json(
          { data: { ...(await buildResponse(existing.id, existing.docNo!)), idempotentReplay: true } },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/stock/transfers", companyId });
  }
}
