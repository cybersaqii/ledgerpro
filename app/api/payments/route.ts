import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { payments, parties, bankAccounts } from "@/db/schema";
import { paymentSchema } from "@/lib/validators";
import { parseMoney } from "@/lib/money";
import { postPayment } from "@/lib/posting";
import { json, err } from "@/lib/api";
import { requireCompany, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";

// GET /api/payments?kind=RECEIPT&partyId=&from=&to=&page=
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const kind = sp.get("kind");
  const partyId = sp.get("partyId");
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(payments.companyId, companyId)];
  if (kind === "RECEIPT" || kind === "PAYMENT") conds.push(eq(payments.kind, kind));
  if (partyId) conds.push(eq(payments.partyId, partyId));
  if (from) {
    try { conds.push(sql`${payments.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${payments.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ p: payments, partyName: parties.name, bankName: bankAccounts.name })
    .from(payments)
    .leftJoin(parties, eq(payments.partyId, parties.id))
    .leftJoin(bankAccounts, eq(payments.bankAccountId, bankAccounts.id))
    .where(and(...conds))
    .orderBy(desc(payments.date), desc(payments.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(payments)
    .where(and(...conds));
  const sums = await db
    .select({
      r: sql<string | null>`sum(case when ${payments.kind} = 'RECEIPT' then ${payments.amount} else 0 end)`,
      p: sql<string | null>`sum(case when ${payments.kind} = 'PAYMENT' then ${payments.amount} else 0 end)`,
    })
    .from(payments)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.p, partyName: r.partyName, bankName: r.bankName })),
    total: total[0]?.n ?? 0,
    sumReceipt: sums[0]?.r ?? "0",
    sumPayment: sums[0]?.p ?? "0",
    page,
    perPage,
  });
}

// POST /api/payments — receipt or payment, with optional invoice/bill allocations
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = paymentSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const amount = parseMoney(b.amount);
  if (amount <= 0n) return err("Amount must be positive.", 422);

  try {
    const paymentId = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);

      let partyId: string;
      {
        if (!b.partyId) throw new Error("Please select a customer or supplier.");
        const pr = await tx
          .select()
          .from(parties)
          .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId)))
          .limit(1);
        if (!pr[0]) throw new Error("Selected party is invalid.");
        partyId = pr[0].id;
      }

      return postPayment(tx, {
        companyId,
        branchId,
        kind: b.kind,
        partyId,
        bankAccountId: b.bankAccountId,
        date: parseDateOnly(b.date),
        amount,
        method: b.method,
        reference: b.reference || undefined,
        notes: b.notes || undefined,
        allocations: b.allocations.map((a) => ({
          docId: a.docId,
          docKind: a.docKind,
          amount: parseMoney(a.amount),
        })),
        createdById: session.uid,
      });
    });
    return json({ data: { id: paymentId } }, { status: 201 });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Could not save the payment.", 422);
  }
}
