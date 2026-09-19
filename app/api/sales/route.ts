import { NextRequest } from "next/server";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { salesDocs, salesDocItems, parties, products } from "@/db/schema";
import { salesDocSchema } from "@/lib/validators";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postSalesDoc } from "@/lib/posting";
import { nextDocNo } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { requireCompany, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

const POSTED_TYPES = ["INVOICE", "RETURN"] as const;

// GET /api/sales?docType=INVOICE&partyId=&q=&from=&to=&page=
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const docType = sp.get("docType");
  const partyId = sp.get("partyId");
  const q = sp.get("q")?.trim() ?? "";
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(salesDocs.companyId, companyId)];
  if (docType) conds.push(eq(salesDocs.docType, docType));
  if (partyId) conds.push(eq(salesDocs.partyId, partyId));
  if (q) conds.push(sql`${salesDocs.docNo} LIKE ${`%${q}%`}`);
  if (from) {
    try { conds.push(sql`${salesDocs.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${salesDocs.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({
      doc: salesDocs,
      partyName: parties.name,
    })
    .from(salesDocs)
    .leftJoin(parties, eq(salesDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(desc(salesDocs.date), desc(salesDocs.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(salesDocs)
    .where(and(...conds));
  const sums = await db
    .select({ s: sql<string | null>`sum(${salesDocs.grandTotal})` })
    .from(salesDocs)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.doc, partyName: r.partyName })),
    total: total[0]?.n ?? 0,
    sumGrandTotal: sums[0]?.s ?? "0",
    page,
    perPage,
  });
}

// POST /api/sales — create invoice/return (posts immediately) or draft doc
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = salesDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  // party must belong to company
  const partyRows = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId), eq(parties.isActive, true)))
    .limit(1);
  const party = partyRows[0];
  if (!party || party.kind !== "CUSTOMER") return err("Please select a valid customer.", 422);

  // resolve products (for stock tracking + validation)
  const productIds = [...new Set(b.items.map((i) => i.productId).filter(Boolean) as string[])];
  const prodRows =
    productIds.length > 0
      ? await db
          .select()
          .from(products)
          .where(and(eq(products.companyId, companyId), inArray(products.id, productIds)))
      : [];
  const prodMap = new Map(prodRows.map((p) => [p.id, p]));
  for (const pid of productIds) {
    if (!prodMap.has(pid)) return err("One of the selected products is invalid.", 422);
  }

  const docItems: DocItemInput[] = b.items.map((i) => ({
    productId: i.productId || null,
    description: i.description,
    qtyMilli: parseQty(i.qty),
    ratePaisa: parseMoney(i.rate),
    discountPaisa: parseMoney(i.discount),
    taxBps: i.taxBps,
  }));

  let totals;
  try {
    totals = computeTotals(docItems, parseMoney(b.discountTotal));
  } catch (e) {
    return err(e instanceof Error ? e.message : "Invalid document totals.", 422);
  }

  const isPosted = (POSTED_TYPES as readonly string[]).includes(b.docType);
  const date = parseDateOnly(b.date);
  const dueDate = b.dueDate ? parseDateOnly(b.dueDate) : null;

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      const docNo = await nextDocNo(tx, companyId, b.docType);
      const docId = crypto.randomUUID();

      await tx.insert(salesDocs).values({
        id: docId,
        companyId,
        branchId,
        partyId: party.id,
        docType: b.docType,
        docNo,
        date,
        dueDate,
        status: isPosted ? "POSTED" : "DRAFT",
        subtotal: totals.subtotal,
        discountTotal: parseMoney(b.discountTotal),
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        notes: b.notes || null,
        createdById: session.uid,
      });
      await tx.insert(salesDocItems).values(
        totals.items.map((i) => ({
          id: crypto.randomUUID(),
          docId,
          productId: i.productId,
          description: i.description,
          qty: i.qtyMilli,
          rate: i.ratePaisa,
          discount: i.discountPaisa,
          taxBps: i.taxBps,
          taxAmount: i.taxAmountPaisa,
          lineTotal: i.lineTotalPaisa,
        }))
      );

      let entryId: string | null = null;
      if (isPosted) {
        entryId = await postSalesDoc(tx, {
          companyId,
          branchId,
          partyId: party.id,
          docId,
          docNo,
          docType: b.docType as "INVOICE" | "RETURN",
          date,
          items: totals.items.map((i) => ({
            ...i,
            trackStock: i.productId ? prodMap.get(i.productId)?.trackStock ?? false : false,
          })),
          discountTotal: parseMoney(b.discountTotal),
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
          createdById: session.uid,
        });
        await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
      }
      return { docId, docNo, entryId };
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `sale.${b.docType.toLowerCase()}.created`,
      entity: "sale", entityId: result.docId,
      detail: `${b.docType} ${result.docNo}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Could not save the document.";
    return err(msg, 422);
  }
}
