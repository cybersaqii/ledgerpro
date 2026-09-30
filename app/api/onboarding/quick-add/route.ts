import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { parties, products } from "@/db/schema";
import { requirePermission, db } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { parseMoney } from "@/lib/money";

// POST /api/onboarding/quick-add — one call creates the wizard's first
// product and/or first party. Both optional; returns what was created.
// { product?: { name, salePrice }, party?: { name, phone, kind } }
export async function POST(req: NextRequest) {
  const gate = await requirePermission("products");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const out: { productId?: string; partyId?: string } = {};

    const prod = body?.product;
    if (prod && String(prod.name || "").trim().length >= 2) {
      const name = String(prod.name).trim().slice(0, 120);
      const salePrice = parseMoney(String(prod.salePrice || "0"));
      // Simple unique SKU for wizard-created products.
      const sku = `WZ-${Date.now().toString(36).toUpperCase()}`;
      const dup = await db
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.companyId, companyId), eq(products.sku, sku)))
        .limit(1);
      if (!dup[0]) {
        await db.insert(products).values({
          companyId, sku, name, unit: "PCS",
          purchasePrice: 0n, salePrice,
          taxBps: 0, trackStock: true, reorderLevel: 0n,
        });
        const [created] = await db
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.companyId, companyId), eq(products.sku, sku)))
          .limit(1);
        if (created) out.productId = created.id;
      }
    }

    const party = body?.party;
    if (party && String(party.name || "").trim().length >= 2) {
      const kind = party.kind === "SUPPLIER" ? "SUPPLIER" : "CUSTOMER";
      const name = String(party.name).trim().slice(0, 120);
      await db.insert(parties).values({
        companyId,
        kind,
        name,
        phone: String(party.phone || "").trim().slice(0, 30) || null,
      });
      const [created] = await db
        .select({ id: parties.id })
        .from(parties)
        .where(and(eq(parties.companyId, companyId), eq(parties.name, name)))
        .limit(1);
      if (created) out.partyId = created.id;
    }

    return json({ data: out }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/onboarding/quick-add", companyId });
  }
}
