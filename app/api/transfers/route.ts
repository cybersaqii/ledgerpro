import { NextRequest } from "next/server";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts } from "@/db/schema";
import { transfers } from "@/db/schema";
import { postTransfer } from "@/lib/transfers";
import { parseMoney } from "@/lib/money";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

const transferSchema = z.object({
  fromBankAccountId: z.string().min(1),
  toBankAccountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
});

// GET /api/transfers?page=&from=&to=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));
  const conds = [eq(transfers.companyId, companyId)];
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    try { conds.push(sql`${transfers.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${transfers.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select()
    .from(transfers)
    .where(and(...conds))
    .orderBy(desc(transfers.date), desc(transfers.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  // Bank names for the from/to columns (drizzle 0.44 dropped the `alias`
  // helper, so resolve names in a second batched query instead of a
  // self-join).
  const bankIds = [...new Set(rows.flatMap((r) => [r.fromBankAccountId, r.toBankAccountId]))];
  const banks = bankIds.length > 0
    ? await db
        .select({ id: bankAccounts.id, name: bankAccounts.name })
        .from(bankAccounts)
        .where(inArray(bankAccounts.id, bankIds))
    : [];
  const nameOf = new Map(banks.map((b) => [b.id, b.name]));
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(transfers)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({
      ...r,
      fromName: nameOf.get(r.fromBankAccountId) ?? null,
      toName: nameOf.get(r.toBankAccountId) ?? null,
      date: (r.date as unknown as Date).getTime(),
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}

// POST /api/transfers — move money between own cash/bank accounts (G2)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = transferSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  // Idempotency: a retry of the same submission (same key) returns the
  // already-created transfer with 200 instead of double-posting.
  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/transfers", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, transfers, companyId, idemKey);
    if (existing)
      return json(
        { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "transfers", session.uid, companyId);
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
      return postTransfer(tx, {
        companyId,
        branchId,
        fromBankAccountId: b.fromBankAccountId,
        toBankAccountId: b.toBankAccountId,
        date,
        amount,
        notes: b.notes || undefined,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "transfer.created", entity: "transfer", entityId: result.id,
      detail: `Transfer ${result.docNo}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    // Lost the idempotency race: a concurrent request already created the
    // transfer for this key — return it with 200 instead of an error.
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, transfers, companyId, idemKey);
      if (existing)
        return json(
          { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/transfers", companyId });
  }
}
