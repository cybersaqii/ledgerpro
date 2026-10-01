import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db, defaultBranchId, parseDateOnly } from "@/lib/route-helpers";
import { convertPurchaseDoc, createPurchaseReturn } from "@/lib/doc-actions";
import { createGrn, convertGrnToBill } from "@/lib/grn";
import { voidPurchaseBill } from "@/lib/purchase-void";
import { issuePurchaseOrder, cancelPurchaseOrder, closePurchaseOrder } from "@/lib/purchase-orders";
import { parseQty } from "@/lib/qty";
import { parseMoney } from "@/lib/money";
import { UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import type { Permission } from "@/lib/permissions";

const returnLineSchema = z.object({
  itemId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

const grnLineSchema = z.object({
  sourceItemId: z.string().min(1),
  receivedQty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
  damagedQty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity").default("0"),
});

// POST /api/purchases/[id]/convert — actions on a purchase document:
//   convert → purchase order -> posted bill (compulsory vendor refNo)
//   grn     → purchase order -> GRN (goods receipt)
//   return  → bill -> purchase return (debit note)
//   issue/cancel/close → purchase order lifecycle actions
//   void    → bill/return -> VOID via reversing journal
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = z
    .enum(["convert", "grn", "bill", "return", "issue", "cancel", "close", "void"])
    .safeParse(body.action).success
    ? body.action
    : "convert";
  const perms: Permission[] =
    action === "convert"
      ? ["documents", "purchases"]
      : action === "issue" || action === "cancel" || action === "close"
        ? ["documents"]
        : ["purchases"];
  for (const p of perms) {
    const gate = await requirePermission(p);
    if (!gate.ok) return gate.response;
  }

  let returnLines: { itemId: string; qty: bigint }[] | undefined;
  if (action === "return" && Array.isArray(body.lines)) {
    const parsed = returnLineSchema.array().max(200).safeParse(body.lines);
    if (!parsed.success) return err("Invalid return quantities.", 422);
    returnLines = parsed.data.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty) }));
  }
  let grnLines: { sourceItemId: string; receivedQty: bigint; damagedQty: bigint }[] | undefined;
  let grnDate: Date | undefined;
  if (action === "grn") {
    const parsed = grnLineSchema.array().min(1).max(500).safeParse(body.lines);
    if (!parsed.success) return err("Invalid receipt quantities.", 422);
    grnLines = parsed.data.map((l) => ({
      sourceItemId: l.sourceItemId,
      receivedQty: parseQty(l.receivedQty),
      damagedQty: parseQty(l.damagedQty),
    }));
    if (body.date) {
      try {
        grnDate = parseDateOnly(body.date);
      } catch {
        return err("Invalid date.", 422);
      }
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = body.branchId || (await defaultBranchId(tx, companyId));
      if (action === "return") {
        return {
          action,
          ...(await createPurchaseReturn(tx, {
            companyId,
            branchId,
            sourceId: id,
            userId: session.uid,
            lines: returnLines,
            deductFromInventory: body.deductFromInventory !== false,
          })),
        };
      }
      if (action === "grn") {
        return {
          action,
          ...(await createGrn(tx, {
            companyId,
            orderId: id,
            partyId: body.partyId,
            branchId,
            date: grnDate ?? new Date(),
            notes: typeof body.notes === "string" ? body.notes : undefined,
            lines: grnLines!,
            userId: session.uid,
          })),
        };
      }
      if (action === "void") {
        const { voidJournalEntryId } = await voidPurchaseBill(tx, {
          companyId,
          billId: id,
          reason: typeof body.reason === "string" ? body.reason : undefined,
          userId: session.uid,
        });
        return { action, docId: id, voidJournalEntryId };
      }
      if (action === "bill") {
        // GRN -> purchase bill (vendor's invoice arrives after the goods)
        const refNo = typeof body.refNo === "string" ? body.refNo.trim() : "";
        if (!refNo) throw new UserError("The vendor's bill reference is required.", 422, "VENDOR_REF_REQUIRED");
        const extraCosts = Array.isArray(body.extraCosts)
          ? body.extraCosts
              .filter((c: { label?: string; amount?: string }) => c.label?.trim() && parseFloat(c.amount || "0") > 0)
              .map((c: { label: string; amount: string }) => ({ label: c.label.trim(), amount: parseMoney(c.amount) }))
          : [];
        return {
          action,
          ...(await convertGrnToBill(tx, {
            companyId,
            branchId,
            grnId: id,
            date: new Date(),
            refNo,
            whtBps: typeof body.whtBps === "number" ? body.whtBps : undefined,
            extraCosts,
            extraCostPaidFrom: body.extraCostPaidFrom === "SUPPLIER" ? "SUPPLIER" : "CASH",
            extraCostAccountId: typeof body.extraCostAccountId === "string" ? body.extraCostAccountId : undefined,
            notes: typeof body.notes === "string" ? body.notes : undefined,
            userId: session.uid,
          })),
        };
      }
      if (action === "issue") {
        await issuePurchaseOrder(tx, companyId, id, new Date());
        return { action, docId: id, status: "ISSUED" };
      }
      if (action === "cancel") {
        await cancelPurchaseOrder(tx, companyId, id, new Date());
        return { action, docId: id, status: "CANCELLED" };
      }
      if (action === "close") {
        await closePurchaseOrder(tx, companyId, id, new Date());
        return { action, docId: id, status: "CLOSED" };
      }
      // convert (order -> bill)
      return {
        action,
        ...(await convertPurchaseDoc(tx, {
          companyId,
          branchId,
          sourceId: id,
          userId: session.uid,
          refNo: typeof body.refNo === "string" ? body.refNo : "",
          whtBps: typeof body.whtBps === "number" ? body.whtBps : undefined,
        })),
      };
    });

    const auditDetail =
      action === "return"
        ? `Purchase return ${"docNo" in result ? result.docNo : ""} created`
        : action === "grn"
          ? `GRN ${"docNo" in result ? result.docNo : ""} received`
          : action === "bill"
            ? `Bill ${"docNo" in result ? result.docNo : ""} created from GRN`
          : action === "void"
            ? `Purchase document voided`
            : action === "issue" || action === "cancel" || action === "close"
              ? `Purchase order ${action}d`
              : `Bill ${"docNo" in result ? result.docNo : ""} converted`;
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `purchase.${action}`,
      entity: "purchase", entityId: result.docId,
      detail: auditDetail,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases/[id]/convert", companyId });
  }
}
