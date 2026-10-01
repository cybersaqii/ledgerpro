import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts, bankAdjustments } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { postBankAdjustment } from "@/lib/bank-adjustments";
import { parseMoney } from "@/lib/money";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

type Ctx = { params: Promise<{ id: string }> };

async function bankOf(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

// GET /api/bank-accounts/[id]/adjustments — list charges/interest for one account
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;
  const bank = await bankOf(companyId, id);
  if (!bank) return err("Bank account not found.", 404);

  const rows = await db
    .select()
    .from(bankAdjustments)
    .where(and(eq(bankAdjustments.companyId, companyId), eq(bankAdjustments.bankAccountId, id)))
    .orderBy(desc(bankAdjustments.date), desc(bankAdjustments.createdAt));
  return json({
    data: rows.map((r) => ({
      ...r,
      amount: r.amount.toString(),
      date: (r.date as unknown as Date).getTime(),
      voidedAt: r.voidedAt ? (r.voidedAt as unknown as Date).getTime() : null,
    })),
  });
}

const adjSchema = z.object({
  kind: z.enum(["CHARGE", "INTEREST"]),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/bank-accounts/[id]/adjustments — one-click bank charge / interest.
// CHARGE: Dr Bank Charges (6010) / Cr Bank · INTEREST: Dr Bank / Cr Interest Income (4030)
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const bank = await bankOf(companyId, id);
  if (!bank) return err("Bank account not found.", 404);

  const body = await req.json().catch(() => null);
  const parsed = adjSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/adjustments", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, bankAdjustments, companyId, idemKey);
    if (existing)
      return json(
        { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "bank_adjustments", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);
  const date = parseDateOnly(b.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postBankAdjustment(tx, {
        companyId,
        branchId,
        bankAccountId: bank.id,
        date,
        kind: b.kind,
        amount,
        notes: b.notes || undefined,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: b.kind === "CHARGE" ? "bank.charge" : "bank.interest",
      entity: "bank_adjustment", entityId: result.id,
      detail: `${b.kind === "CHARGE" ? "Bank charges" : "Bank interest"} ${result.docNo} on "${bank.name}"`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, bankAdjustments, companyId, idemKey);
      if (existing)
        return json(
          { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/bank-accounts/[id]/adjustments", companyId });
  }
}
