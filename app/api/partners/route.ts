import { NextRequest } from "next/server";
import { eq, and, sql } from "drizzle-orm";
import { z } from "zod";
import { partners, journalLines, journalEntries, accounts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { registerPartner } from "@/lib/partners";
import { logAudit } from "@/lib/audit";

// GET /api/partners — list with capital/current balances
export async function GET() {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const rows = await db.select().from(partners).where(eq(partners.companyId, companyId));

  // Balances from GL: sum of journal lines per account.
  const balances = new Map<string, bigint>();
  if (rows.length > 0) {
    const accountIds = rows.flatMap((p) => [p.capitalAccountId, p.currentAccountId]);
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
          sql`${journalLines.accountId} IN (${sql.join(accountIds.map((a) => sql`${a}`), sql`, `)})`
        )
      )
      .groupBy(journalLines.accountId);
    for (const s of sums) balances.set(s.accountId, BigInt(s.bal));
  }

  return json({
    data: rows.map((p) => ({
      ...p,
      capitalBalance: (balances.get(p.capitalAccountId) ?? 0n).toString(),
      currentBalance: (balances.get(p.currentAccountId) ?? 0n).toString(),
    })),
  });
}

const registerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(30).optional(),
  cnic: z.string().trim().max(30).optional(),
  profitShareBps: z.number().int().min(0).max(10000),
  notes: z.string().trim().max(500).optional(),
});

// POST /api/partners — register (creates 301x/302x GL accounts)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("partners");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = registerSchema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  // Unique name per company.
  const existing = await db
    .select({ id: partners.id })
    .from(partners)
    .where(and(eq(partners.companyId, companyId), eq(partners.name, b.data.name)))
    .limit(1);
  if (existing[0]) return err("A partner with this name already exists.", 409);

  const result = await db.transaction(async (tx) => {
    return registerPartner(tx, {
      companyId,
      name: b.data.name,
      phone: b.data.phone,
      cnic: b.data.cnic,
      profitShareBps: b.data.profitShareBps,
      notes: b.data.notes,
      createdById: session.uid,
    });
  });

  await logAudit(db, {
    companyId,
    userId: session.uid, userName: session.name,
    action: "partner.register",
    entity: "partner",
    entityId: result.id,
    detail: `Registered ${b.data.name} (${b.data.profitShareBps / 100}%)`,
  });

  return json({ data: result }, { status: 201 });
}
