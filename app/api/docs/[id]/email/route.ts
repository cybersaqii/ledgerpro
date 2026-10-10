import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, requirePermission, db } from "@/lib/route-helpers";
import { getSalesDocDetail, getPurchaseDocDetail } from "@/lib/doc-detail";
import { sendEmail, brandEmailHeader } from "@/lib/email";
import { brand } from "@/lib/brand";
import { logAudit } from "@/lib/audit";
import { fmtMoneyShortRs, fmtQty } from "@/lib/format";
import type { Permission } from "@/lib/permissions";

const emailSchema = z.object({
  to: z.string().trim().toLowerCase().email(),
});

/** Quotations are governed by the documents permission; sales docs by sales, purchase docs by purchases. */
function permFor(isSales: boolean, docType: string | null | undefined): Permission {
  if (docType === "QUOTATION") return "documents";
  return isSales ? "sales" : "purchases";
}

function docTitle(docType: string | null | undefined, isSales: boolean): string {
  if (docType === "QUOTATION") return "Quotation";
  if (docType === "CHALLAN") return "Challan";
  return isSales ? "Invoice" : "Bill";
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const { companyId, session } = auth;
  const { id } = await params;

  const body = await req.json().catch(() => null);
  const parsed = emailSchema.safeParse(body);
  if (!parsed.success) return err("Please enter a valid email address.", 422);
  const { to } = parsed.data;

  const salesDoc = await getSalesDocDetail(db, companyId, id);
  const purchaseDoc = salesDoc ? null : await getPurchaseDocDetail(db, companyId, id);
  const doc = salesDoc ?? purchaseDoc;
  if (!doc) return err("Not found.", 404);
  const isSales = !!salesDoc;
  const gate = await requirePermission(permFor(isSales, doc.docType));
  if (!gate.ok) return gate.response;

  const [company] = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const companyName = company?.name || brand.name;
  const title = docTitle(doc.docType, isSales);
  const docDate = doc.date ? new Date(Number(doc.date)).toDateString() : "";
  const appUrl = process.env.APP_URL || "https://ledgerpro-pw5c.vercel.app";
  const viewLink = `${appUrl}/${isSales ? "sales" : "purchases"}/${doc.id}`;
  const grandTotal = doc.grandTotal ?? "0";
  const paid = doc.amountPaid ?? "0";
  const balance = (BigInt(grandTotal) - BigInt(paid)).toString();

  const itemRows = (doc.items as Array<{ description: string; qty: string | number | bigint; rate: string | number | bigint; lineTotal: string | number | bigint; unit?: string | null }>)
    .map(
      (it) =>
        `<tr><td style="padding:8px;border-bottom:1px solid #e5e7eb">${it.description}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtQty(it.qty, it.unit ?? "")}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right">${fmtMoneyShortRs(it.rate)}</td>` +
        `<td style="padding:8px;border-bottom:1px solid #e5e7eb;text-align:right"><strong>${fmtMoneyShortRs(it.lineTotal)}</strong></td></tr>`
    )
    .join("");

  const result = await sendEmail({
    to,
    subject: `${title} ${doc.docNo} from ${companyName}`,
    html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;color:#111">
      ${brandEmailHeader()}
      <div style="padding:16px 8px 0">
      <h2 style="margin-bottom:4px">${title} ${doc.docNo}</h2>
      <p style="color:#555;margin-top:0">from ${companyName}${doc.partyName ? ` · for ${doc.partyName}` : ""}${docDate ? ` · ${docDate}` : ""}</p>
      <table style="width:100%;border-collapse:collapse;margin:16px 0">
        <thead><tr>
          <th style="text-align:left;padding:8px;border-bottom:2px solid #111">Item</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #111">Qty</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #111">Rate</th>
          <th style="text-align:right;padding:8px;border-bottom:2px solid #111">Amount</th>
        </tr></thead>
        <tbody>${itemRows}</tbody>
      </table>
      <p style="text-align:right"><strong>Total: ${fmtMoneyShortRs(grandTotal)}</strong><br/>
      Paid: ${fmtMoneyShortRs(paid)}<br/>Balance: ${fmtMoneyShortRs(balance)}</p>
      <p><a href="${viewLink}">View this document in ${brand.name}</a></p>
      <hr/><p style="color:#555;font-size:13px">یہ ${title.toLowerCase()} ${companyName} کی طرف سے ${brand.name} کے ذریعے بھیجا گیا ہے۔</p>
      </div>
    </div>`,
    text: `${title} ${doc.docNo} from ${companyName}\nTotal: ${fmtMoneyShortRs(grandTotal)} · Paid: ${fmtMoneyShortRs(paid)} · Balance: ${fmtMoneyShortRs(balance)}\nView: ${viewLink}`,
  });

  if (!result.ok) {
    return err(result.skipped ? "Email is not configured yet." : "Could not send the email. Please try again.", 502);
  }

  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "doc.email",
    entity: isSales ? "sales_doc" : "purchase_doc",
    entityId: doc.id,
    detail: `${title} ${doc.docNo} emailed to ${to}`,
  });

  return json({ ok: true });
}
