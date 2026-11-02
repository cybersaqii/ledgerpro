import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, requirePermission, db, defaultBranchId } from "@/lib/route-helpers";
import { convertSalesDoc, createSalesReturn } from "@/lib/doc-actions";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";
import { salesDocs } from "@/db/schema";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
} from "@/lib/idempotency";

const returnLineSchema = z.object({
  itemId: z.string().min(1),
  qty: z.string().regex(/^\d{1,12}(\.\d{1,3})?$/, "Invalid quantity"),
});

// POST /api/sales/[id]/convert — convert a quotation/order/challan
// (targetType: INVOICE default | CHALLAN | ORDER), or post a sales return
// (action=return, optional restoreStock=false for a pure-ledger credit note).
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const action = body.action === "return" ? "return" : "convert";
  // Converting a quotation into an invoice touches both areas; a sales return
  // is purely a sales operation.
  const perms = action === "return" ? (["sales"] as const) : (["documents", "sales"] as const);
  for (const p of perms) {
    const gate = await requirePermission(p);
    if (!gate.ok) return gate.response;
  }
  const priceOverride = body.priceOverride === true;
  const applyAdvance = body.applyAdvance !== false;
  const targetType: "INVOICE" | "CHALLAN" | "ORDER" =
    body.targetType === "CHALLAN" ? "CHALLAN" : body.targetType === "ORDER" ? "ORDER" : "INVOICE";
  const restoreStock = body.restoreStock !== false;
  // partial return: per-item quantities; omitted = full return of what remains
  let returnLines: { itemId: string; qty: bigint }[] | undefined;
  if (action === "return" && Array.isArray(body.lines)) {
    const parsed = returnLineSchema.array().max(200).safeParse(body.lines);
    if (!parsed.success) return err("Invalid return quantities.", 422);
    returnLines = parsed.data.map((l) => ({ itemId: l.itemId, qty: parseQty(l.qty) }));
  }

  // QA sweep 2026-11-01 (Low): convert/return had no idempotency key, so a
  // retried tap errored on the CONVERTED stamp instead of replaying. The
  // stamp still blocks duplicates; the key only turns the retry into a
  // clean 200 with the already-created doc. No new column needed: the
  // created doc's own idempotency_key (migration 0031) carries the key.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/convert", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, salesDocs, companyId, idemKey);
    if (existing) {
      return json(
        { data: { docId: existing.id, docNo: existing.docNo, idempotentReplay: true } },
      );
    }
  }

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      const args = { companyId, branchId, sourceId: id, userId: session.uid, priceOverride, applyAdvance, lines: returnLines, targetType, restoreStock };
      if (action === "return") return createSalesReturn(tx, args);
      return convertSalesDoc(tx, args);
    });
    if (idemKey) {
      // Stamp the created doc so a retry replays instead of converting
      // twice. A unique-conflict here means a concurrent request won the
      // race — re-read and replay its doc.
      try {
        await db.update(salesDocs).set({ idempotencyKey: idemKey }).where(eq(salesDocs.id, result.docId));
      } catch (e) {
        if (isIdempotencyConflict(e)) {
          const hit = await findByIdempotencyKey(db, salesDocs, companyId, idemKey);
          if (hit) {
            return json(
              { data: { docId: hit.id, docNo: hit.docNo, idempotentReplay: true } },
            );
          }
        }
        // Stamping is best-effort: the conversion itself already succeeded,
        // so never fail the response over it (a later retry then behaves
        // exactly as before — "already converted" error, no duplicate).
        console.error("[sales convert] idempotency stamp failed", e);
      }
    }
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: action === "return" ? "sale.return.created" : "sale.converted",
      entity: "sale", entityId: result.docId,
      detail: action === "return"
        ? `Sales return ${result.docNo} created${restoreStock ? "" : " (pure-ledger, no stock)"}`
        : `${targetType === "INVOICE" ? "Invoice" : targetType === "ORDER" ? "Order" : "Challan"} ${result.docNo} converted`,
    });
    if (action === "convert" && (result.advanceApplied ?? 0n) > 0n) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.advance_applied",
        entity: "sale", entityId: result.docId,
        detail: `Advance auto-applied on conversion to ${result.docNo}`,
      });
    }
    if (action === "convert" && priceOverride) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.price_override",
        entity: "sale", entityId: result.docId,
        detail: `Converted below minimum price (invoice ${result.docNo})`,
      });
    }
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/sales/[id]/convert", companyId });
  }
}
