// POST /api/assets/[id]/sell — sell an asset for a price received into a
// bank/cash account. Gain/loss is computed automatically and posted:
// Dr bank/cash + Dr accum dep + Dr 6030 (loss) / Cr asset cost + Cr 4110 (gain).
import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { sellAsset } from "@/lib/assets";
import { parseMoney } from "@/lib/money";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";

const sellSchema = z.object({
  salePrice: z.union([z.string(), z.number()]),
  date: z.string().min(1).optional(),
  bankAccountId: z.string().min(1),
  idempotencyKey: z.string().min(1).optional(),
});

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await ctx.params;
  const b = sellSchema.safeParse(await req.json().catch(() => ({})));
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid sale.", 422);
  const date = b.data.date ? new Date(b.data.date) : new Date();
  if (isNaN(date.getTime())) return err("Invalid date.", 422);
  try {
    const { journalEntryId, gainLossPaisa } = await db.transaction((tx) =>
      sellAsset(tx, {
        companyId,
        assetId: id,
        salePricePaisa: parseMoney(b.data.salePrice),
        date,
        bankAccountId: b.data.bankAccountId,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "assets.sold", entity: "asset", entityId: id,
      detail: `gain/loss ${gainLossPaisa.toString()} paisa`, ip: clientIp(req),
    });
    return json({ data: { id, journalEntryId, gainLossPaisa: gainLossPaisa.toString() } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: `/api/assets/${id}/sell`, companyId });
  }
}
