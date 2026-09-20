import { NextRequest } from "next/server";
import { heldBillSchema } from "@/lib/validators";
import { createHeldBill, listHeldBills } from "@/lib/held";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { logAudit } from "@/lib/audit";
import { users } from "@/db/schema";
import { eq } from "drizzle-orm";

// GET /api/pos/held — list held bills (owners see all in company, staff see own).
export async function GET() {
  const gate = await requirePermission("held_bills");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const bills = await listHeldBills(db, {
    companyId,
    userId: session.uid,
    role: session.role,
    userNameById: async (id) => {
      const r = await db.select({ name: users.name }).from(users).where(eq(users.id, id)).limit(1);
      return r[0]?.name ?? null;
    },
  });
  return json({ data: bills });
}

// POST /api/pos/held — park the current cart on the server.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("held_bills");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = heldBillSchema.safeParse(body);
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;

  if (!parsed.success) return err("Please check the held bill and try again.", 422);
  const b = parsed.data;
  const id = await createHeldBill(db, {
    companyId,
    userId: session.uid,
    label: b.label,
    lines: b.lines.map((l) => ({
      productId: l.productId ?? null,
      name: l.name,
      sku: l.sku ?? "",
      unit: l.unit ?? "PCS",
      qty: l.qty,
      rate: l.rate,
      discount: l.discount,
    })),
    discount: b.discount,
  });
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "pos.held_created",
    entity: "held_bill",
    entityId: id,
    detail: `Held bill ${b.label || id.slice(0, 8)} (${b.lines.length} items)`,
  });
  return json({ data: { id } }, { status: 201 });
}
