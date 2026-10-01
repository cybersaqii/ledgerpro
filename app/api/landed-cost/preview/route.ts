import { NextRequest } from "next/server";
import { z } from "zod";
import { parseMoney } from "@/lib/money";
import { previewLandedCost } from "@/lib/landed-cost";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, defaultBranchId, assertBranch } from "@/lib/route-helpers";

// Same shape as the money strings accepted by the post schema.
const amountStr = z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount");

const previewSchema = z.object({
  branchId: z.string().min(1).optional(),
  purchaseDocId: z.string().min(1).optional().or(z.literal("")),
  basis: z.enum(["VALUE", "QTY", "WEIGHT"]),
  heads: z
    .array(
      z.object({
        head: z.enum(["FREIGHT", "DUTY", "CLEARING", "OTHER"]),
        label: z.string().trim().max(60).optional().or(z.literal("")),
        amount: amountStr,
      })
    )
    .min(1)
    .max(20),
  lines: z.array(z.object({ productId: z.string().min(1) })).max(500).default([]),
});

// POST /api/landed-cost/preview — read-only allocation preview (no writes).
export async function POST(req: NextRequest) {
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const body = await req.json().catch(() => null);
  const parsed = previewSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  try {
    const branchId = b.branchId || (await defaultBranchId(db, companyId));
    await assertBranch(db, companyId, branchId);
    const data = await db.transaction((tx) =>
      previewLandedCost(tx, {
        companyId,
        branchId,
        purchaseDocId: b.purchaseDocId || null,
        basis: b.basis,
        heads: b.heads.map((h) => ({
          head: h.head,
          label: h.label || undefined,
          amountPaisa: parseMoney(h.amount),
        })),
        lines: b.lines.map((l) => ({ productId: l.productId })),
      })
    );
    return json({ data });
  } catch (e) {
    return toApiError(e, { route: "/api/landed-cost/preview", companyId });
  }
}
