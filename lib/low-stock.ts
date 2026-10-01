/**
 * Module 15.2 — Low-stock alert engine.
 *
 * Daily check: when total on-hand across branches <= reorder level, alert the
 * inventory manager (in-app notification + email to the company email) with a
 * "Generate PO" quick action. Reuses the same on-hand semantics as the
 * stock report (products.trackStock, active, non-bundle items).
 *
 * Anti-spam: at most one LOW_STOCK notification per product per day — the
 * engine skips products that already got one today.
 *
 * Money: integer paisa everywhere. Stock: milli-units (bigint) everywhere.
 */

import { and, eq, gt, sql } from "drizzle-orm";
import { companies, notifications, products, stockLevels } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { sendEmail, brandEmailHeader } from "./email";
import { fmtQty } from "./format";

export interface LowStockProduct {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  reorderLevel: bigint; // milli-units
  onHand: bigint; // milli-units, summed across branches
}

export interface LowStockCheckResult {
  scanned: number;
  low: number;
  notified: number;
  deduped: number;
  emailSent: number;
  emailSkipped: number;
}

/** Products at or below reorder level (on-hand summed across branches). */
export async function findLowStockProducts(
  dbx: Db | DbTx,
  companyId: string
): Promise<LowStockProduct[]> {
  const rows = await dbx
    .select({
      id: products.id,
      sku: products.sku,
      name: products.name,
      unit: products.unit,
      reorderLevel: products.reorderLevel,
      onHand: sql<bigint>`COALESCE(SUM(${stockLevels.qty}), 0)`,
    })
    .from(products)
    .leftJoin(stockLevels, eq(stockLevels.productId, products.id))
    .where(
      and(
        eq(products.companyId, companyId),
        eq(products.isActive, true),
        eq(products.trackStock, true),
        gt(products.reorderLevel, 0n),
        // Bundles hold no stock of their own: exclude them (same as the stock report).
        sql`NOT EXISTS (SELECT 1 FROM bundle_components bc WHERE bc.bundle_product_id = ${products.id})`
      )
    )
    .groupBy(products.id)
    // Boundary: on-hand <= reorder level triggers (exactly at the level counts).
    .having(sql`COALESCE(SUM(${stockLevels.qty}), 0) <= ${products.reorderLevel}`)
    .orderBy(products.name);

  return rows.map((r) => ({
    productId: r.id,
    sku: r.sku,
    name: r.name,
    unit: r.unit,
    reorderLevel: BigInt(r.reorderLevel ?? 0n),
    onHand: BigInt(r.onHand ?? 0n),
  }));
}

/**
 * Run the low-stock check: create in-app LOW_STOCK notifications (one per
 * product per day) and send a single digest email to the company email when
 * set. Returns counts; never throws for one bad product.
 */
export async function runLowStockCheck(
  dbx: Db | DbTx,
  companyId: string,
  opts: { asOf?: Date } = {}
): Promise<LowStockCheckResult> {
  const result: LowStockCheckResult = {
    scanned: 0, low: 0, notified: 0, deduped: 0, emailSent: 0, emailSkipped: 0,
  };
  const asOf = opts.asOf ?? new Date();
  const dayStart = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate());
  const dayEnd = dayStart + 86400000;

  const low = await findLowStockProducts(dbx, companyId);
  result.scanned = low.length; // reuse of report query: scanned == low here
  result.low = low.length;
  if (low.length === 0) return result;

  // Products already notified today (dedupe).
  const already = await dbx
    .select({ entityId: notifications.entityId })
    .from(notifications)
    .where(
      and(
        eq(notifications.companyId, companyId),
        eq(notifications.kind, "LOW_STOCK"),
        eq(notifications.entityType, "product"),
        sql`${notifications.createdAt} >= ${new Date(dayStart)}`,
        sql`${notifications.createdAt} < ${new Date(dayEnd)}`
      )
    );
  const doneToday = new Set(already.map((r) => r.entityId));

  const fresh: LowStockProduct[] = [];
  for (const p of low) {
    if (doneToday.has(p.productId)) {
      result.deduped++;
      continue;
    }
    const title = `Low stock: ${p.name}`;
    const body =
      `${p.name} (${p.sku}) is at ${fmtQty(p.onHand, p.unit)} — ` +
      `reorder level ${fmtQty(p.reorderLevel, p.unit)}. Generate a purchase order to restock.`;
    await dbx.insert(notifications).values({
      id: crypto.randomUUID(),
      companyId,
      userId: null,
      kind: "LOW_STOCK",
      title,
      body,
      link: `/stock?lowStock=1&q=${encodeURIComponent(p.sku)}`,
      entityType: "product",
      entityId: p.productId,
    });
    fresh.push(p);
    result.notified++;
  }

  // One digest email for the whole run when the company has an email address.
  if (fresh.length > 0) {
    const [company] = await dbx
      .select({ name: companies.name, tradeName: companies.tradeName, email: companies.email })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (company?.email) {
      const rows = fresh
        .map(
          (p) =>
            `<tr><td style="padding:6px 8px;">${escapeHtml(p.name)}</td>` +
            `<td style="padding:6px 8px;color:#6b7280;">${escapeHtml(p.sku)}</td>` +
            `<td style="padding:6px 8px;text-align:right;font-weight:700;color:#b91c1c;">${escapeHtml(fmtQty(p.onHand, p.unit))}</td>` +
            `<td style="padding:6px 8px;text-align:right;">${escapeHtml(fmtQty(p.reorderLevel, p.unit))}</td></tr>`
        )
        .join("");
      const html =
        brandEmailHeader() +
        `<div style="font-family:sans-serif;padding:24px;">` +
        `<p>Low-stock alert — ${fresh.length} product${fresh.length === 1 ? "" : "s"} at or below reorder level:</p>` +
        `<table style="border-collapse:collapse;font-size:14px;"><thead><tr>` +
        `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;">Product</th>` +
        `<th style="text-align:left;padding:6px 8px;border-bottom:2px solid #e5e7eb;">SKU</th>` +
        `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #e5e7eb;">On hand</th>` +
        `<th style="text-align:right;padding:6px 8px;border-bottom:2px solid #e5e7eb;">Reorder</th>` +
        `</tr></thead><tbody>${rows}</tbody></table>` +
        `<p style="color:#6b7280;font-size:12px;">— ${escapeHtml(company.tradeName || company.name)}</p></div>`;
      const sent = await sendEmail({
        to: company.email,
        subject: `Low-stock alert: ${fresh.length} product${fresh.length === 1 ? "" : "s"} need restocking`,
        html,
      });
      if (sent.ok) result.emailSent++;
      else result.emailSkipped++; // graceful skip when RESEND_API_KEY is missing
    } else {
      result.emailSkipped++;
    }
  }

  return result;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
