import { NextRequest } from "next/server";
import { eq, desc } from "drizzle-orm";
import { z } from "zod";
import { profitDistributions, distributionEntries } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { createDistribution } from "@/lib/partners";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";

// GET /api/partners/distributions — list runs with per-partner shares
export async function GET() {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const runs = await db
    .select()
    .from(profitDistributions)
    .where(eq(profitDistributions.companyId, companyId))
    .orderBy(desc(profitDistributions.periodEnd));

  const withEntries = await Promise.all(
    runs.map(async (r) => {
      const entries = await db
        .select()
        .from(distributionEntries)
        .where(eq(distributionEntries.distributionId, r.id));
      return {
        ...r,
        totalAmountPaisa: r.totalAmountPaisa.toString(),
        entries: entries.map((e) => ({ ...e, amountPaisa: e.amountPaisa.toString() })),
      };
    })
  );
  return json({ data: withEntries });
}

const createSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  // Signed decimal string: "500000.00" profit, "-20000.00" loss.
  totalAmount: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  memo: z.string().trim().max(300).optional(),
});

// POST /api/partners/distributions — create DRAFT run
export async function POST(req: NextRequest) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;

  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  try {
    const distId = await db.transaction(async (tx) => {
      return createDistribution(tx, {
        companyId,
        periodStart: parseDateOnly(b.data.periodStart),
        periodEnd: parseDateOnly(b.data.periodEnd),
        totalAmountPaisa: parseMoney(b.data.totalAmount),
        memo: b.data.memo,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId,
      userId: session.uid, userName: session.name,
      action: "partner.distribution.create",
      entity: "profit_distribution",
      entityId: distId,
      detail: `Distribution draft Rs ${b.data.totalAmount}`,
    });
    return json({ data: { id: distId } }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}
