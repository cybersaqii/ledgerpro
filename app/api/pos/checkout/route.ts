import { NextRequest } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { salesDocs, salesDocItems, parties, products, bankAccounts } from "@/db/schema";
import { posCheckoutSchema } from "@/lib/validators";
import { computeTotals, type DocItemInput } from "@/lib/totals";
import { parseMoney } from "@/lib/money";
import { parseQty } from "@/lib/qty";
import { postSalesDoc, postPayment } from "@/lib/posting";
import { periodLockError } from "@/lib/period";
import { nextDocNo } from "@/lib/setup";
import { applyCustomerAdvance } from "@/lib/advance";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireCompany, db, parseDateOnly, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";

import { logAudit } from "@/lib/audit";
import { belowMinPrice, floorErrorMessage } from "@/lib/min-price";

// POST /api/pos/checkout — atomic POS sale.
// Creates the invoice AND its receipt(s) inside ONE database transaction:
// if the receipt step fails, the invoice is rolled back too (no unpaid
// ghost bills). `payments: []` means khata (unpaid). Multiple payment
// entries = split payment, each posting its own receipt.
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = posCheckoutSchema.safeParse(body);
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;

  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  // Party must be an active customer of this company.
  const partyRows = await db
    .select()
    .from(parties)
    .where(and(eq(parties.id, b.partyId), eq(parties.companyId, companyId), eq(parties.isActive, true)))
    .limit(1);
  const party = partyRows[0];
  if (!party || party.kind !== "CUSTOMER") return err("Please select a valid customer.", 422);

  // Products must belong to this company.
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

  // Minimum sale price lock: any line priced below its product's floor needs
  // an explicit override (which is audit-logged below).
  const belowFloor = belowMinPrice(b.items, prodMap);
  if (belowFloor.length > 0 && !b.priceOverride) {
    return err(floorErrorMessage(belowFloor), 422);
  }

  // Cash/bank accounts must belong to this company.
  const bankIds = [...new Set(b.payments.map((p) => p.bankAccountId))];
  const bankRows =
    bankIds.length > 0
      ? await db
          .select({ id: bankAccounts.id })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.companyId, companyId), inArray(bankAccounts.id, bankIds)))
      : [];
  if (bankRows.length !== bankIds.length) return err("One of the selected cash/bank accounts is invalid.", 422);

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
    return toApiError(e, { route: "/api/pos/checkout", companyId });
  }

  const payAmounts = b.payments.map((p) => parseMoney(p.amount));
  if (payAmounts.some((a) => a <= 0n)) return err("Payment amounts must be positive.", 422);
  const payTotal = payAmounts.reduce((a, x) => a + x, 0n);
  if (payTotal > totals.grandTotal) return err("Payments exceed the bill total.", 422);

  const tendered = b.tendered ? parseMoney(b.tendered) : 0n;
  if (tendered > 0n && payTotal >= totals.grandTotal && tendered < totals.grandTotal)
    return err("Tendered amount is less than the bill total.", 422);
  const change = tendered > totals.grandTotal ? tendered - totals.grandTotal : 0n;

  const date = parseDateOnly(b.date);

  const lockErr = await periodLockError(db, companyId, date);
  if (lockErr) return err(lockErr, 422);

  try {
    const result = await db.transaction(async (tx) => {
      const branchId = await defaultBranchId(tx, companyId);
      await assertBranch(tx, companyId, branchId);
      const docNo = await nextDocNo(tx, companyId, "INVOICE");
      const docId = crypto.randomUUID();

      await tx.insert(salesDocs).values({
        id: docId,
        companyId,
        branchId,
        partyId: party.id,
        docType: "INVOICE",
        docNo,
        date,
        dueDate: null,
        status: "POSTED",
        subtotal: totals.subtotal,
        discountTotal: parseMoney(b.discountTotal),
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        notes: b.notes || "POS sale",
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

      const entryId = await postSalesDoc(tx, {
        companyId,
        branchId,
        partyId: party.id,
        docId,
        docNo,
        docType: "INVOICE",
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

      // Receipts — each allocated against the new invoice, all in the same txn.
      let remaining = totals.grandTotal;
      const paymentIds: string[] = [];
      for (let k = 0; k < b.payments.length; k++) {
        const p = b.payments[k];
        const alloc = payAmounts[k] > remaining ? remaining : payAmounts[k];
        if (alloc <= 0n) continue;
        const pid = await postPayment(tx, {
          companyId,
          branchId,
          kind: "RECEIPT",
          partyId: party.id,
          bankAccountId: p.bankAccountId,
          date,
          amount: payAmounts[k],
          method: p.method,
          reference: p.reference || undefined,
          notes: "POS sale",
          allocations: [{ docId, docKind: "SALES", amount: alloc }],
          createdById: session.uid,
        });
        paymentIds.push(pid);
        remaining -= alloc;
      }
      // advance auto-deduction on whatever is still unpaid (khata / partial)
      const paidTotal = totals.grandTotal - remaining;
      let advanceApplied = 0n;
      if (remaining > 0n) {
        advanceApplied = await applyCustomerAdvance(tx, {
          companyId,
          partyId: party.id,
          docId,
          grandTotal: totals.grandTotal,
          alreadyPaid: paidTotal,
        });
      }
      return { docId, docNo, paymentIds, paidTotal, advanceApplied };
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pos.checkout",
      entity: "sale", entityId: result.docId,
      detail: `POS invoice ${result.docNo}`,
    });
    if (belowFloor.length > 0) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pos.price_override",
        entity: "sale", entityId: result.docId,
        detail: `Sold below minimum price: ${belowFloor.join(", ")} (invoice ${result.docNo})`,
      });
    }
    if (result.advanceApplied > 0n) {
      await logAudit(db, {
        companyId, userId: session.uid, userName: session.name,
        action: "pos.advance_applied",
        entity: "sale", entityId: result.docId,
        detail: `Advance auto-applied to POS invoice ${result.docNo}`,
      });
    }
    return json(
      {
        data: {
          docId: result.docId,
          docNo: result.docNo,
          paymentIds: result.paymentIds,
          grandTotal: totals.grandTotal,
          paidTotal: result.paidTotal,
          advanceApplied: result.advanceApplied,
          change,
        },
      },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/pos/checkout", companyId });
  }
}
