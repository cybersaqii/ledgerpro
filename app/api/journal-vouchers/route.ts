import { NextRequest } from "next/server";
import { z } from "zod";
import { journalEntries } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, defaultBranchId, assertBranch, parseDateOnly } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { postManualJournal, parseLineAmount } from "@/lib/journal-vouchers";
import { logAudit } from "@/lib/audit";
import {
  extractIdempotencyKey,
  findByIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

const lineSchema = z.object({
  accountId: z.string().min(1),
  debit: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid debit").default("0"),
  credit: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid credit").default("0"),
  partyId: z.string().min(1).nullable().optional(),
  memo: z.string().trim().max(200).optional(),
});

const jvSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date"),
  memo: z.string().trim().min(1, "A memo / narration is required.").max(500),
  branchId: z.string().min(1).optional(),
  lines: z.array(lineSchema).min(2, "A voucher needs at least two lines.").max(40),
});

// POST /api/journal-vouchers — manual journal voucher (JV-YYYY-0001).
// STRICT: total Dr must equal total Cr — the server re-validates even though
// the UI disables Save until the difference is zero.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = jvSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid journal voucher.", 422);

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/journal-vouchers", companyId });
  }
  if (idemKey) {
    const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
    if (existing)
      return json({ data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } }, { status: 200 });
  }
  const rl = await throttleMoneyCreate(db, "journal-vouchers", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  const date = parseDateOnly(b.data.date);
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  let lines;
  try {
    lines = b.data.lines.map((l) => ({
      accountId: l.accountId,
      debit: parseLineAmount(l.debit),
      credit: parseLineAmount(l.credit),
      partyId: l.partyId || undefined,
      memo: l.memo || undefined,
    }));
  } catch (e) {
    return toApiError(e, { route: "/api/journal-vouchers", companyId });
  }

  try {
    const { entryId, docNo } = await db.transaction(async (tx) => {
      const branchId = b.data.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postManualJournal(tx, {
        companyId,
        branchId,
        date,
        memo: b.data.memo,
        lines,
        createdById: session.uid,
        ...(idemKey ? { idempotencyKey: idemKey } : {}),
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "journal.created", entity: "journal", entityId: entryId,
      detail: `Manual journal voucher ${docNo}`,
    });
    return json({ data: { id: entryId, docNo } }, { status: 201 });
  } catch (e) {
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findByIdempotencyKey(db, journalEntries, companyId, idemKey);
      if (existing)
        return json({ data: { id: existing.id, docNo: existing.docNo, idempotentReplay: true } }, { status: 200 });
    }
    return toApiError(e, { route: "/api/journal-vouchers", companyId });
  }
}
