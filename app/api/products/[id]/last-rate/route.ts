import { NextRequest } from "next/server";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { getLastRate } from "@/lib/last-rate";

// GET /api/products/[id]/last-rate?side=SALE|PURCHASE&partyId=
// The product's last posted rate — this party's first, anyone's as fallback.
// The invoice/bill form shows it under the rate field ("Last: Rs …").
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const side = req.nextUrl.searchParams.get("side") === "PURCHASE" ? "PURCHASE" : "SALE";
  const gate = await requirePermission(side === "PURCHASE" ? "purchases" : "sales");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await params;
  const partyId = req.nextUrl.searchParams.get("partyId")?.trim() || null;

  const rate = await getLastRate(db, companyId, id, side, partyId);
  return json({ rate });
}
