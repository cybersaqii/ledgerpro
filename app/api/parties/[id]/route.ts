import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { parties } from "@/db/schema";

import { partySchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { requireCompany, db, requirePermission } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { isForeignKeyViolation } from "@/lib/company-delete";

async function find(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, id), eq(parties.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404, "NOT_FOUND");
  return json({ data: row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404, "NOT_FOUND");
  const body = await req.json().catch(() => null);
  const parsed = partySchema.partial().safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const p = parsed.data;

  // Module 1: the opening balance is written once at creation (it is a
  // posted journal + the party's starting balance) — changing it later would
  // silently unbalance the ledger. Reject any attempt.
  if (
    (p.openingBalance !== undefined && p.openingBalance !== "0" && p.openingBalance !== "") ||
    p.openingBalanceDate !== undefined
  ) {
    return err("Opening balance cannot be changed after the party is created.", 422, "OPENING_LOCKED");
  }

  await db
    .update(parties)
    .set({
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.phone !== undefined ? { phone: p.phone || null } : {}),
      ...(p.email !== undefined ? { email: p.email || null } : {}),
      ...(p.address !== undefined ? { address: p.address || null } : {}),
      ...(p.city !== undefined ? { city: p.city || null } : {}),
      ...(p.ntn !== undefined ? { ntn: p.ntn || null } : {}),
      ...(p.customerType !== undefined ? { customerType: p.customerType } : {}),
      ...(p.currency !== undefined ? { currency: p.currency || null } : {}),
      ...(p.strn !== undefined ? { strn: p.strn || null } : {}),
      ...(p.paymentTerms !== undefined ? { paymentTerms: p.paymentTerms || null } : {}),
      ...(p.shippingAddress !== undefined ? { shippingAddress: p.shippingAddress || null } : {}),
      ...(p.shippingCity !== undefined ? { shippingCity: p.shippingCity || null } : {}),
      ...(p.filerStatus !== undefined ? { filerStatus: p.filerStatus } : {}),
      // Module 2.1: supplier master completeness
      ...(p.displayName !== undefined ? { displayName: p.displayName || null } : {}),
      ...(p.whtCategory !== undefined ? { whtCategory: p.whtCategory } : {}),
      ...(p.activeTaxPayer !== undefined ? { activeTaxPayer: p.activeTaxPayer } : {}),
      ...(p.bankIban !== undefined ? { bankIban: p.bankIban || null } : {}),
      ...(p.bankAccountNo !== undefined ? { bankAccountNo: p.bankAccountNo || null } : {}),
      ...(p.creditLimit !== undefined ? { creditLimit: parseMoney(p.creditLimit || "0") } : {}),
      ...(p.notes !== undefined ? { notes: p.notes || null } : {}),
      updatedAt: new Date(),
 })
    .where(eq(parties.id, id));
  if (p.category !== undefined) {
    await db.update(parties).set({ category: p.category || null }).where(eq(parties.id, id));
  }
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "party.updated", entity: "party", entityId: id,
    detail: `Party "${row.name}" updated`,
 });
  return json({ data: await find(companyId, id) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404, "NOT_FOUND");
  if (row.balance !== 0n) return err("Cannot delete a party with an outstanding balance.", 400, "DELETE_BLOCKED");
  try {
    await db.update(parties).set({ isActive: false }).where(eq(parties.id, id));
  } catch (e) {
    if (isForeignKeyViolation(e)) return err("Cannot delete this party: linked records exist.", 409, "DELETE_BLOCKED");
    throw e;
  }
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "party.deleted", entity: "party", entityId: id,
    detail: `Party "${row.name}" deactivated`,
 });
  return json({ ok: true });
}
