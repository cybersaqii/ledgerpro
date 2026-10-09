import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { postPartnerMovement } from "@/lib/partners";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";

const schema = z.object({
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  accountId: z.string().min(1, "Cash/bank account required"),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
  memo: z.string().trim().max(300).optional(),
});

// POST /api/partners/[id]/contribute — capital contribution (Dr Cash → Cr Capital)
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
    const result = await db.transaction(async (tx) => {
      return postPartnerMovement(tx, {
        companyId,
        partnerId: id,
        kind: "CONTRIBUTION",
        amountPaisa: parseMoney(b.data.amount),
        accountId: b.data.accountId,
        date: b.data.date ? parseDateOnly(b.data.date) : new Date(),
        memo: b.data.memo,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId,
      userId: session.uid, userName: session.name,
      action: "partner.contribute",
      entity: "partner",
      entityId: id,
      detail: `Capital contribution Rs ${b.data.amount}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}
