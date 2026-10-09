import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { partners, journalLines, journalEntries } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

async function getPartner(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(partners)
    .where(and(eq(partners.id, id), eq(partners.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

// GET /api/partners/[id] — detail with balances
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;

  const p = await getPartner(companyId, id);
  if (!p) return err("Partner not found.", 404);

  const sums = await db
    .select({
      accountId: journalLines.accountId,
      bal: sql<string>`COALESCE(SUM(${journalLines.credit} - ${journalLines.debit}), 0)`,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.companyId, companyId),
        sql`${journalLines.accountId} IN (${p.capitalAccountId}, ${p.currentAccountId})`
      )
    )
    .groupBy(journalLines.accountId);
  const balMap = new Map(sums.map((s) => [s.accountId, BigInt(s.bal)]));

  return json({
    data: {
      ...p,
      capitalBalance: (balMap.get(p.capitalAccountId) ?? 0n).toString(),
      currentBalance: (balMap.get(p.currentAccountId) ?? 0n).toString(),
    },
  });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  cnic: z.string().trim().max(30).nullable().optional(),
  profitShareBps: z.number().int().min(0).max(10000).optional(),
  isActive: z.boolean().optional(),
  notes: z.string().trim().max(500).nullable().optional(),
});

// PATCH /api/partners/[id] — edit share %, deactivate, etc.
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;

  const p = await getPartner(companyId, id);
  if (!p) return err("Partner not found.", 404);

  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (b.data.name !== undefined) patch.name = b.data.name;
  if (b.data.phone !== undefined) patch.phone = b.data.phone;
  if (b.data.cnic !== undefined) patch.cnic = b.data.cnic;
  if (b.data.profitShareBps !== undefined) patch.profitShareBps = b.data.profitShareBps;
  if (b.data.isActive !== undefined) patch.isActive = b.data.isActive;
  if (b.data.notes !== undefined) patch.notes = b.data.notes;

  await db.update(partners).set(patch).where(eq(partners.id, id));
  await logAudit(db, {
    companyId,
    userId: session.uid, userName: session.name,
    action: "partner.update",
    entity: "partner",
    entityId: id,
    detail: `Updated ${p.name}`,
  });
  return json({ ok: true });
}
