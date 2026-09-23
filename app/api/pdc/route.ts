import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { pdcCheques, parties } from "@/db/schema";
import { pdcSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { recordPdc } from "@/lib/pdc";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { periodLockError } from "@/lib/period";
import { logAudit } from "@/lib/audit";

// GET /api/pdc?kind=RECEIVED&status=PENDING&partyId=&from=&to=&page=
export async function GET(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind");
  const status = sp.get("status");
  const partyId = sp.get("partyId");
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(pdcCheques.companyId, companyId)];
  if (kind === "RECEIVED" || kind === "ISSUED") conds.push(eq(pdcCheques.kind, kind));
  if (status) conds.push(eq(pdcCheques.status, status));
  if (partyId) conds.push(eq(pdcCheques.partyId, partyId));
  if (from) {
    try { conds.push(sql`${pdcCheques.chequeDate} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${pdcCheques.chequeDate} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ p: pdcCheques, partyName: parties.name })
    .from(pdcCheques)
    .leftJoin(parties, eq(pdcCheques.partyId, parties.id))
    .where(and(...conds))
    .orderBy(desc(pdcCheques.chequeDate), desc(pdcCheques.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(pdcCheques)
    .where(and(...conds));
  const pending = await db
    .select({
      r: sql<string | null>`sum(case when ${pdcCheques.kind} = 'RECEIVED' and ${pdcCheques.status} = 'PENDING' then ${pdcCheques.amount} else 0 end)`,
      i: sql<string | null>`sum(case when ${pdcCheques.kind} = 'ISSUED' and ${pdcCheques.status} = 'PENDING' then ${pdcCheques.amount} else 0 end)`,
    })
    .from(pdcCheques)
    .where(eq(pdcCheques.companyId, companyId));
  return json({
    data: rows.map((r) => ({ ...r.p, partyName: r.partyName })),
    total: total[0]?.n ?? 0,
    pendingReceived: pending[0]?.r ?? "0",
    pendingIssued: pending[0]?.i ?? "0",
  });
}

// POST /api/pdc — record a post-dated cheque
export async function POST(req: NextRequest) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = pdcSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);

  const chequeDate = parseDateOnly(b.chequeDate);
  const lockErr = await periodLockError(db, companyId, chequeDate);
  if (lockErr) return err(lockErr, 422);

  try {
    const pdcId = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      return recordPdc(tx, {
        companyId,
        branchId,
        kind: b.kind,
        partyId: b.partyId,
        chequeNo: b.chequeNo,
        bankName: b.bankName || undefined,
        amount,
        chequeDate,
        refNo: b.refNo || undefined,
        notes: b.notes || undefined,
        createdById: session.uid,
      });
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pdc.recorded", entity: "pdc", entityId: pdcId,
      detail: `${b.kind} chq ${b.chequeNo}`,
    });
    return json({ data: { id: pdcId } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/pdc", companyId });
  }
}
