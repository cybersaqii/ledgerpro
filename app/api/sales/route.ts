import { NextRequest } from "next/server";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { salesDocs, salesDocItems, parties, products, productBatches } from "@/db/schema";
import { salesDocSchema } from "@/lib/validators";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postSalesDoc } from "@/lib/posting";
import { periodLockError } from "@/lib/period";
import { nextDocNo } from "@/lib/setup";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { belowMinPrice, floorErrorMessage } from "@/lib/min-price";
import { applyCustomerAdvance } from "@/lib/advance";
import { enforceCreditLimit, CreditLimitError } from "@/lib/credit-limit";
import type { Permission } from "@/lib/permissions";

const POSTED_TYPES = ["INVOICE", "RETURN"] as const;

/** Quotations are governed by the documents permission; invoices/returns by sales. */
function permForDocType(docType: string | null): Permission {
  return docType === "QUOTATION" ? "documents" : "sales";
}

// GET /api/sales?docType=INVOICE&partyId=&q=&from=&to=&page=
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
  const body = await req.json().catch(() => null);
  const parsed = salesDocSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const gate = await requirePermission(permForDocType(parsed.data.docType));
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
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

  // Minimum sale price lock applies to posted invoices only (not quotes/orders).
  const belowFloor = b.docType === "INVOICE" ? belowMinPrice(b.items, prodMap) : [];
  if (belowFloor.length > 0 && !b.priceOverride) {
    return err(floorErrorMessage(belowFloor), 422);
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
    return toApiError(e, { route: "/api/sales", companyId });
  }

  const isPosted = (POSTED_TYPES as readonly string[]).includes(b.docType);
  const date = parseDateOnly(b.date);
  const dueDate = b.dueDate ? parseDateOnly(b.dueDate) : null;

  // Batch choices are only meaningful on posted docs: the chosen batch must
  // belong to this company and to the line's product.
  if (isPosted) {
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
        discountTotal: parseMoney(b.discountTotal || "0"),
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
      let advanceApplied = 0n;
      if (isPosted) {
        entryId = await postSalesDoc(tx, {
          companyId,
          branchId,
          partyId: party.id,
          docId,
          docNo,
          docType: b.docType as "INVOICE" | "RETURN",
          date,
          items: totals.items.map((i, idx) => ({
            ...i,
            trackStock: i.productId ? prodMap.get(i.productId)?.trackStock ?? false : false,
            batchId: (b.items[idx]?.batchId || "").trim() || null,
          })),
          discountTotal: parseMoney(b.discountTotal || "0"),
          taxTotal: totals.taxTotal,
          grandTotal: totals.grandTotal,
          createdById: session.uid,
        });
        await tx.update(salesDocs).set({ journalEntryId: entryId }).where(eq(salesDocs.id, docId));
        // advance auto-deduction: consume the customer's unallocated credit
        if (b.docType === "INVOICE" && b.applyAdvance) {
          advanceApplied = await applyCustomerAdvance(tx, {
            companyId,
            partyId: party.id,
            docId,
            grandTotal: totals.grandTotal,
          });
        }
        // udhaar control: block posted invoices that cross the credit limit
        // (checked after posting so payments/advances are already reflected)
        if (b.docType === "INVOICE" && !b.overrideCreditLimit) {
          await enforceCreditLimit(tx, { companyId, partyId: party.id, newCreditPaisa: totals.grandTotal - advanceApplied });
        }
      }
      return { docId, docNo, entryId, advanceApplied };
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: `sale.${b.docType.toLowerCase()}.created`,
      entity: "sale", entityId: result.docId,
      detail: `${b.docType} ${result.docNo}`,
    });
    if (belowFloor.length > 0) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.price_override",
        entity: "sale", entityId: result.docId,
        detail: `Sold below minimum price: ${belowFloor.join(", ")} (${b.docType} ${result.docNo})`,
      });
    }
    if (result.advanceApplied > 0n) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.advance_applied",
        entity: "sale", entityId: result.docId,
        detail: `Advance Rs ${(result.advanceApplied / 100n).toLocaleString()} auto-applied to ${result.docNo}`,
      });
    }
    if (b.overrideCreditLimit) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "sale.credit_limit_override",
        entity: "sale", entityId: result.docId,
        detail: `Posted ${result.docNo} with credit-limit override`,
      });
    }
    return json({ data: result }, { status: 201 });
  } catch (e) {
    if (e instanceof CreditLimitError)
      return json({ error: e.message, code: "CREDIT_LIMIT_EXCEEDED", details: e.details }, { status: 409 });
    return toApiError(e, { route: "/api/sales", companyId });
  }
}
