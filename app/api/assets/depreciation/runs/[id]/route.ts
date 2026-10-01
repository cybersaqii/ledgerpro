// GET /api/assets/depreciation/runs/[id] — run detail + snapshot entries.
import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { getRunWithEntries } from "@/lib/assets";

export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("assets");
  if (!gate.ok) return gate.response;
  const { id } = await ctx.params;
  const found = await getRunWithEntries(db, gate.companyId, id);
  if (!found) return err("Depreciation run not found.", 404);
  return json({ data: found });
}
