import { NextRequest } from "next/server";
import { eq, and, sql, inArray } from "drizzle-orm";
import { parties, salesDocs, purchaseDocs, payments } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";

// GET /api/parties/[id]/stats — Customer 360: lifetime value, bills, payments, last activity
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;

  const [party] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, id), eq(parties.companyId, companyId)))
    .limit(1);
  if (!party) return err("Party not found.", 404);

  const isCustomer = party.kind === "CUSTOMER";
  const docsTable = isCustomer ? salesDocs : purchaseDocs;
  const mainType = isCustomer ? "INVOICE" : "BILL";

  const sumOf = async (docType: string) => {
    const r = await db
      .select({ total: sql<string | null>`sum(${docsTable.grandTotal})`, n: sql<number>`count(*)` })
      .from(docsTable)
      .where(
        and(
          eq(docsTable.companyId, companyId),
          eq(docsTable.partyId, id),
          eq(docsTable.docType, docType),
          // Paid / partially-paid / returned docs still count toward lifetime
          // business — only drafts are excluded.
          inArray(docsTable.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"])
        )
      );
    return { total: BigInt(r[0]?.total ?? "0"), n: r[0]?.n ?? 0 };
  };

  const main = await sumOf(mainType);
  const ret = await sumOf("RETURN");
  const lifetime = main.total - ret.total;
  const avgBill = main.n > 0 ? main.total / BigInt(main.n) : 0n;

  const lastRows = await db
    .select({ date: docsTable.date })
    .from(docsTable)
    .where(
      and(
        eq(docsTable.companyId, companyId),
        eq(docsTable.partyId, id),
        eq(docsTable.docType, mainType),
        inArray(docsTable.status, ["POSTED", "PARTIAL", "PAID", "RETURNED"])
      )
    )
    .orderBy(sql`${docsTable.date} desc`)
    .limit(1);

  const payKind = isCustomer ? "RECEIPT" : "PAYMENT";
  const payRows = await db
    .select({ total: sql<string | null>`sum(${payments.amount})`, n: sql<number>`count(*)` })
    .from(payments)
    .where(and(eq(payments.companyId, companyId), eq(payments.partyId, id), eq(payments.kind, payKind)));

  return json({
    data: {
      party: { id: party.id, name: party.name, kind: party.kind, phone: party.phone, city: party.city },
      outstanding: party.balance.toString(),
      lifetime: lifetime.toString(),
      billCount: main.n,
      returnTotal: ret.total.toString(),
      avgBill: avgBill.toString(),
      paymentsTotal: (payRows[0]?.total ?? "0").toString(),
      paymentCount: payRows[0]?.n ?? 0,
      lastActivity: lastRows[0]?.date ? new Date(lastRows[0].date).toISOString() : null,
    },
  });
}
