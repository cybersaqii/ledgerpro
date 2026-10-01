import { NextRequest } from "next/server";
import { and, desc, eq, sql } from "drizzle-orm";
import { landedCostSheets, landedCostHeads, products, purchaseDocs } from "@/db/schema";
import { landedCostSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { postLandedCostSheet } from "@/lib/landed-cost";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";
import {
  extractIdempotencyKey,
  isIdempotencyConflict,
  throttleMoneyCreate,
} from "@/lib/idempotency";

// GET /api/landed-cost?status=POSTED&from=&to=&page=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status");
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(landedCostSheets.companyId, companyId)];
  if (status === "POSTED" || status === "VOID") conds.push(eq(landedCostSheets.status, status));
  if (from) {
    try { conds.push(sql`${landedCostSheets.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${landedCostSheets.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ sheet: landedCostSheets, docNo: purchaseDocs.docNo, docType: purchaseDocs.docType })
    .from(landedCostSheets)
    .leftJoin(purchaseDocs, eq(landedCostSheets.purchaseDocId, purchaseDocs.id))
    .where(and(...conds))
    .orderBy(desc(landedCostSheets.date), desc(landedCostSheets.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(landedCostSheets)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({
      ...r.sheet,
      docLabel: r.docNo ? `${r.docType} ${r.docNo}` : null,
      totalPaisa: r.sheet.totalPaisa.toString(),
    })),
    total: total[0]?.n ?? 0,
  });
}

async function findSheetByIdemKey(companyId: string, key: string) {
  const rows = await db
    .select({ id: landedCostSheets.id, sheetNo: landedCostSheets.sheetNo })
    .from(landedCostSheets)
    .where(and(eq(landedCostSheets.companyId, companyId), eq(landedCostSheets.idempotencyKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

// POST /api/landed-cost — post a landed-cost sheet.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("purchases");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = landedCostSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;

  let idemKey: string | undefined;
  try {
    idemKey = extractIdempotencyKey(req, body);
  } catch (e) {
    return toApiError(e, { route: "/api/landed-cost", companyId });
  }
  if (idemKey) {
    const existing = await findSheetByIdemKey(companyId, idemKey);
    if (existing)
      return json(
        { data: { id: existing.id, sheetNo: existing.sheetNo, idempotentReplay: true } },
        { status: 200 }
      );
  }
  const rl = await throttleMoneyCreate(db, "landed-cost", session.uid, companyId);
  if (!rl.ok)
    return json(
      { error: "Too many requests. Please wait a moment and try again.", code: "RATE_LIMITED" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec) } }
    );

  let date: Date;
  try {
    date = parseDateOnly(b.date);
  } catch (e) {
    return toApiError(e, { route: "/api/landed-cost", companyId });
  }
  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422, "PERIOD_LOCKED");

  try {
    const heads = b.heads.map((h) => ({
      head: h.head,
      label: h.label || undefined,
      amountPaisa: parseMoney(h.amount),
    }));
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return postLandedCostSheet(tx, {
        companyId,
        branchId,
        date,
        purchaseDocId: b.purchaseDocId || null,
        basis: b.basis,
        heads,
        lines: b.lines.map((l) => ({ productId: l.productId })),
        createdById: session.uid,
        idempotencyKey: idemKey,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "landed_cost.posted", entity: "landed_cost", entityId: result.sheetId,
      detail: `${result.sheetNo} (${b.basis})`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    if (idemKey && isIdempotencyConflict(e)) {
      const existing = await findSheetByIdemKey(companyId, idemKey);
      if (existing)
        return json(
          { data: { id: existing.id, sheetNo: existing.sheetNo, idempotentReplay: true } },
          { status: 200 }
        );
    }
    return toApiError(e, { route: "/api/landed-cost", companyId });
  }
}
