import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { calcTimeWeightedShares } from "@/lib/partners";

const schema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalAmount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/),
});

// POST /api/partners/distributions/preview — time-weighted share preview (no DB write)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const body = await req.json().catch(() => ({}));
  const b = schema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  try {
    const shares = await db.transaction(async (tx) => {
      return calcTimeWeightedShares(
        tx,
        companyId,
        parseDateOnly(b.data.periodStart),
        parseDateOnly(b.data.periodEnd),
        parseMoney(b.data.totalAmount)
      );
    });
    return json({
      data: shares.map((s) => ({
        ...s,
        capitalDays: s.capitalDays.toString(),
        amount: s.amount.toString(),
      })),
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Preview failed.", 422);
  }
}
