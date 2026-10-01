// GET /api/manufacturing/boms — list BOMs.
// POST /api/manufacturing/boms — create a new BOM version for a finished product.
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { createBom, listBoms } from "@/lib/manufacturing";
import { parseQty } from "@/lib/qty";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const lineSchema = z.object({
  componentProductId: z.string().min(1),
  qty: z.union([z.string(), z.number()]), // units per one finished unit
  scrapPct: z.number().int().min(0).max(100).optional(),
});

const createSchema = z.object({
  productId: z.string().min(1),
  lines: z.array(lineSchema).min(1),
  notes: z.string().max(500).optional(),
});

export async function GET() {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  try {
    const rows = await listBoms(db, gate.companyId);
    return json({ data: rows });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/boms", companyId: gate.companyId });
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("manufacturing");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid BOM.", 422);
  try {
    const { bomId, version } = await db.transaction((tx) =>
      createBom(tx, {
        companyId,
        productId: b.data.productId,
        lines: b.data.lines.map((l) => ({
          componentProductId: l.componentProductId,
          qtyMilli: parseQty(l.qty),
          scrapPct: l.scrapPct ?? 0,
        })),
        notes: b.data.notes,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "manufacturing.bom.created", entity: "bom", entityId: bomId,
      detail: `v${version}`, ip: clientIp(req),
    });
    return json({ data: { id: bomId, version } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/manufacturing/boms", companyId });
  }
}
