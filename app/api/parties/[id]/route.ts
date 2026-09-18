import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { parties } from "@/db/schema";
import { partySchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

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
  if (!row) return err("Not found.", 404);
  return json({ data: row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404);
  const body = await req.json().catch(() => null);
  const parsed = partySchema.partial().safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const p = parsed.data;

  await db
    .update(parties)
    .set({
      ...(p.name !== undefined ? { name: p.name } : {}),
      ...(p.phone !== undefined ? { phone: p.phone || null } : {}),
      ...(p.email !== undefined ? { email: p.email || null } : {}),
      ...(p.address !== undefined ? { address: p.address || null } : {}),
      ...(p.city !== undefined ? { city: p.city || null } : {}),
      ...(p.ntn !== undefined ? { ntn: p.ntn || null } : {}),
      ...(p.filerStatus !== undefined ? { filerStatus: p.filerStatus } : {}),
      ...(p.creditLimit !== undefined ? { creditLimit: parseMoney(p.creditLimit) } : {}),
      ...(p.notes !== undefined ? { notes: p.notes || null } : {}),
      updatedAt: new Date(),
    })
    .where(eq(parties.id, id));
  return json({ data: await find(companyId, id) });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const row = await find(companyId, id);
  if (!row) return err("Not found.", 404);
  if (row.balance !== 0n) return err("Cannot delete a party with an outstanding balance.", 400);
  await db.update(parties).set({ isActive: false }).where(eq(parties.id, id));
  return json({ ok: true });
}
