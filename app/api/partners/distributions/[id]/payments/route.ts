import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { parseMoney } from "@/lib/money";
import { recordDistributionPayment, getDistributionPaymentStatus } from "@/lib/partners";
import { logAudit } from "@/lib/audit";

const schema = z.object({
  partnerId: z.string().min(1),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  accountId: z.string().min(1),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  memo: z.string().trim().max(300).optional(),
});

// POST /api/partners/distributions/[id]/payments — record a payment
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;

  const body = await req.json().catch(() => ({}));
  const b = schema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  try {
    const payId = await db.transaction(async (tx) => {
      return recordDistributionPayment(tx, {
        companyId,
        distributionId: id,
        partnerId: b.data.partnerId,
        amountPaisa: parseMoney(b.data.amount),
        accountId: b.data.accountId,
        date: parseDateOnly(b.data.date),
        memo: b.data.memo,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId,
      userId: session.uid, userName: session.name,
      action: "partner.distribution.pay",
      entity: "distribution_payment",
      entityId: payId,
      detail: "Distribution payment recorded",
    });
    return json({ data: { id: payId } });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}

// GET /api/partners/distributions/[id]/payments — paid/pending per partner
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;

  const status = await db.transaction(async (tx) => {
    return getDistributionPaymentStatus(tx, companyId, id);
  });
  return json({
    data: status.map((s) => ({
      ...s,
      share: s.share.toString(),
      paid: s.paid.toString(),
      pending: s.pending.toString(),
    })),
  });
}
