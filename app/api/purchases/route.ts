import { NextRequest } from "next/server";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { purchaseDocs, purchaseDocItems, parties, products, productBatches } from "@/db/schema";
import { purchaseDocSchema } from "@/lib/validators";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postPurchaseDoc, distributeExtraCost } from "@/lib/posting";
import { periodLockError } from "@/lib/period";
import { nextDocNo } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import type { Permission } from "@/lib/permissions";

const POSTED_TYPES = ["BILL", "RETURN"] as const;

/** Purchase orders are governed by the documents permission; bills/returns by purchases. */
function permForDocType(docType: string | null): Permission {
  return docType === "PURCHASE_ORDER" ? "documents" : "purchases";
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const docType = sp.get("docType");
  const gate = await requirePermission(permForDocType(docType));
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const partyId = sp.get("partyId");
  const q = sp.get("q")?.trim() ?? "";
  const from = sp.get("from");
  const to = sp.get("to");
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(purchaseDocs.companyId, companyId)];
  if (docType) conds.push(eq(purchaseDocs.docType, docType));
  if (partyId) conds.push(eq(purchaseDocs.partyId, partyId));
  if (q) conds.push(sql`${purchaseDocs.docNo} LIKE ${`%${q}%`}`);
  if (from) {
    try { conds.push(sql`${purchaseDocs.date} >= ${parseDateOnly(from).getTime()}`); } catch { /* ignore */ }
  }
  if (to) {
    try { conds.push(sql`${purchaseDocs.date} < ${parseDateOnly(to).getTime() + 86400000}`); } catch { /* ignore */ }
  }

  const rows = await db
    .select({ doc: purchaseDocs, partyName: parties.name })
    .from(purchaseDocs)
    .leftJoin(parties, eq(purchaseDocs.partyId, parties.id))
    .where(and(...conds))
    .orderBy(desc(purchaseDocs.date), desc(purchaseDocs.createdAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseDocs)
    .where(and(...conds));
  const sums = await db
    .select({ s: sql<string | null>`sum(${purchaseDocs.grandTotal})` })
    .from(purchaseDocs)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({ ...r.doc, partyName: r.partyName })),
    total: total[0]?.n ?? 0,
    sumGrandTotal: sums[0]?.s ?? "0",
    page,
    perPage,
  });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const parsed = purchaseDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const gate = await requirePermission(permForDocType(parsed.data.docType));
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const b = parsed.data;

  const partyRows = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId), eq(parties.isActive, true)))
    .limit(1);
  const party = partyRows[0];
  if (!party || party.kind !== "SUPPLIER") return err("Please select a valid supplier.", 422);

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
    ratePaisa: parseMoney(i.rate || "0"),
    discountPaisa: parseMoney(i.discount || "0"),
    taxBps: i.taxBps,
  }));

  let totals;
  try {
    totals = computeTotals(docItems, parseMoney(b.discountTotal || "0"));
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }

  const isPosted = (POSTED_TYPES as readonly string[]).includes(b.docType);
  const date = parseDateOnly(b.date);
  const dueDate = b.dueDate ? parseDateOnly(b.dueDate) : null;

  // Return lines may choose a batch to deduct from: it must belong to this
  // company and to the line's product. Bill lines carry batch_no/expiry_date
  // instead (validated strictly at posting time).
  if (isPosted && b.docType === "RETURN") {
    const wanted = b.items
      .map((i) => ({ batchId: (i.batchId || "").trim(), productId: i.productId || "" }))
      .filter((x) => x.batchId && x.productId);
    if (wanted.length > 0) {
      const ids = [...new Set(wanted.map((x) => x.batchId))];
      const rows = await db
        .select({ id: productBatches.id, productId: productBatches.productId })
        .from(productBatches)
        .where(and(eq(productBatches.companyId, companyId), inArray(productBatches.id, ids)));
      const ownerOf = new Map(rows.map((r) => [r.id, r.productId]));
      for (const w of wanted) {
        if (ownerOf.get(w.batchId) !== w.productId)
          return err("The selected batch is not valid for this product.", 422);
      }
    }
  }

  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  // Landed extra costs: distribute over stock-tracked lines (same math as posting)
  const extraCosts = (b.extraCosts ?? [])
    .map((c) => ({ label: c.label, amount: parseMoney(c.amount) }))
    .filter((c) => c.amount > 0n);
  const totalExtra = extraCosts.reduce((a, c) => a + c.amount, 0n);

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      const docNo = await nextDocNo(tx, companyId, b.docType);
      const docId = crypto.randomUUID();

      const stockNets: { idx: number; net: bigint }[] = [];
      totals.items.forEach((it, idx) => {
        const track = it.productId ? prodMap.get(it.productId)?.trackStock ?? false : false;
        if (track) stockNets.push({ idx, net: it.taxablePaisa });
      });
      const landed = new Array<bigint>(totals.items.length).fill(0n);
      if (totalExtra > 0n) {
        const dist = distributeExtraCost(stockNets.map((s) => s.net), totalExtra);
        stockNets.forEach((s, j) => { landed[s.idx] = dist[j] ?? 0n; });
      }

      await tx.insert(purchaseDocs).values({
        id: docId,
        companyId,
        branchId,
        partyId: party.id,
        docType: b.docType,
        docNo,
        refNo: b.refNo || null,
        date,
        dueDate,
        status: isPosted ? "POSTED" : "DRAFT",
        subtotal: totals.subtotal,
        discountTotal: parseMoney(b.discountTotal || "0"),
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        notes: b.notes || null,
        createdById: session.uid,
      });
      await tx.insert(purchaseDocItems).values(
        totals.items.map((i, idx) => ({
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
          extraCost: landed[idx] ?? 0n,
        }))
      );

      let entryId: string | null = null;
      if (isPosted) {
        entryId = await postPurchaseDoc(tx, {
          companyId,
          branchId,
          partyId: party.id,
          docId,
          docNo,
          docType: b.docType as "BILL" | "RETURN",
          date,
          items: totals.items.map((i, idx) => ({
            ...i,
            trackStock: i.productId ? prodMap.get(i.productId)?.trackStock ?? false : false,
            batchNo: (b.items[idx]?.batchNo || "").trim() || null,
            expiryDate: (b.items[idx]?.expiryDate || "").trim() || null,
            batchId: (b.items[idx]?.batchId || "").trim() || null,
          })),
          discountTotal: parseMoney(b.discountTotal || "0"),
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
          createdById: session.uid,
          extraCosts,
          extraCostPaidFrom: b.extraCostPaidFrom,
          extraCostAccountId: b.extraCostAccountId || undefined,
        });
        await tx.update(purchaseDocs).set({ journalEntryId: entryId }).where(eq(purchaseDocs.id, docId));
      }
      return { docId, docNo, entryId };
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `purchase.${b.docType.toLowerCase()}.created`,
      entity: "purchase", entityId: result.docId,
      detail: `${b.docType} ${result.docNo}${totalExtra > 0n ? ` (+ extra costs Rs ${(totalExtra / 100n).toLocaleString()})` : ""}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/purchases", companyId });
  }
}
