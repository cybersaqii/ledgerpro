import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts, bankAccounts, sundryReceipts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import { postSundryReceipt } from "@/lib/posting";
import { parseMoney } from "@/lib/money";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

const receiptSchema = z.object({
  accountId: z.string().min(1), // credited GL account: INCOME or ASSET
  bankAccountId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  amount: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid amount"),
  notes: z.string().trim().max(500).optional().or(z.literal("")),
  // Module 3: spawn from a bank statement line
  statementLineId: z.string().min(1).optional(),
});

// GET /api/sundry-receipts?page=&from=&to= — list direct receipts
export async function GET(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));
  const conds = [eq(sundryReceipts.companyId, companyId)];
  const from = sp.get("from");
  const to = sp.get("to");
  if (from) {
    try { conds.push(sql`${sundryReceipts.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${sundryReceipts.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ r: sundryReceipts, accountName: accounts.name, bankName: bankAccounts.name })
    .from(sundryReceipts)
    .leftJoin(accounts, eq(sundryReceipts.accountId, accounts.id))
    .leftJoin(bankAccounts, eq(sundryReceipts.bankAccountId, bankAccounts.id))
    .where(and(...conds))
    .orderBy(desc(sundryReceipts.date), desc(sundryReceipts.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(sundryReceipts)
    .where(and(...conds));

  return json({
    data: rows.map(({ r, accountName, bankName }) => ({
      ...r,
      amount: r.amount.toString(),
      date: (r.date as unknown as Date).getTime(),
      voidedAt: r.voidedAt ? (r.voidedAt as unknown as Date).getTime() : null,
      accountName,
      bankName,
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}

// POST /api/sundry-receipts — direct (non-invoiced) receipt: Dr Bank / Cr Income-or-Asset
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = receiptSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/sundry-receipts", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, sundryReceipts, companyId, idemKey);
    if (existing)
      return json(
        { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "sundry_receipts", session.uid, companyId);
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
      return postSundryReceipt(tx, {
        companyId,
        branchId,
        accountId: b.accountId,
        bankAccountId: b.bankAccountId,
        date,
        amount,
        notes: b.notes || undefined,
        createdById: session.uid,
        ...(b.statementLineId ? { statementLineId: b.statementLineId } : {}),
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "sundry_receipt.created", entity: "sundry_receipt", entityId: result.id,
      detail: `Sundry receipt ${result.docNo}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, sundryReceipts, companyId, idemKey);
      if (existing)
        return json(
          { data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/sundry-receipts", companyId });
  }
}
