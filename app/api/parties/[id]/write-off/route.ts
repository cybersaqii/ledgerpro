import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { postWriteOff } from "@/lib/writeoff";
import { writeOffs } from "@/db/schema";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

type Ctx = { params: Promise<{ id: string }> };

const writeOffSchema = z.object({
  salesDocId: z.string().min(1),
  accountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/parties/[id]/write-off — bad-debt write-off on an overdue
// invoice (G7): Dr Bad Debts / Cr AR, collectible balance reduced, aging
// nets it off, invoice kept on record as written off.
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id: partyId } = await ctx.params;
  const body = await req.json().catch(() => null);
  const parsed = writeOffSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);
  const date = parseDateOnly(b.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postWriteOff(tx, {
        companyId,
        branchId,
        partyId,
        salesDocId: b.salesDocId,
        accountId: b.accountId,
        date,
        amount,
        notes: b.notes || undefined,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "writeoff.created", entity: "write_off", entityId: result.id,
      detail: `Write-off ${result.docNo} for party ${partyId.slice(0, 8)}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/parties/[id]/write-off", companyId });
  }
}

// GET /api/parties/[id]/write-off — write-off records for a party (used
// for the recovery affordance on a written-off invoice).
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id: partyId } = await ctx.params;
  const rows = await db
    .select({
      id: writeOffs.id, docNo: writeOffs.docNo, date: writeOffs.date,
      amount: writeOffs.amount, notes: writeOffs.notes,
      salesDocId: writeOffs.salesDocId, recoveredAt: writeOffs.recoveredAt,
    })
    .from(writeOffs)
    .where(and(eq(writeOffs.companyId, companyId), eq(writeOffs.partyId, partyId)))
    .orderBy(desc(writeOffs.date));
  return json({ data: rows });
}
