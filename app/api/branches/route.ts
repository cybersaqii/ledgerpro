import { NextRequest } from "next/server";
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { requireCompany, db, requirePermission } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { branches } from "@/db/schema";

// GET /api/branches — id + name of the company's branches (default first),
// used by branch pickers (e.g. the stock-transfer dialog). Includes the
// Module 4 location type (WAREHOUSE | SHOP | VAN | OTHER).
export async function GET() {
  const auth = await requireCompany();
  if (!auth.ok) return auth.response;
  const rows = await db
    .select({ id: branches.id, name: branches.name, isDefault: branches.isDefault, locationType: branches.locationType })
    .from(branches)
    .where(eq(branches.companyId, auth.companyId))
    .orderBy(desc(branches.isDefault), asc(branches.name));
  return json({ data: rows.map((r) => ({ id: r.id, name: r.name, isDefault: !!r.isDefault, locationType: r.locationType })) });
}

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  locationType: z.enum(["WAREHOUSE", "SHOP", "VAN", "OTHER"]).optional(),
});

// PATCH /api/branches?id= — rename a branch or change its location type.
export async function PATCH(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const id = req.nextUrl.searchParams.get("id")?.trim() || "";
  if (!id) return err("Branch id is required.", 422);
  const body = await req.json().catch(() => null);
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const rows = await db
    .select()
    .from(branches)
    .where(eq(branches.id, id))
    .limit(1);
  const row = rows[0];
  if (!row || row.companyId !== companyId) return err("Branch not found.", 404, "NOT_FOUND");
  await db
    .update(branches)
    .set({
      ...(parsed.data.name !== undefined ? { name: parsed.data.name } : {}),
      ...(parsed.data.locationType !== undefined ? { locationType: parsed.data.locationType } : {}),
    })
    .where(eq(branches.id, id));
  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "branch.updated", entity: "branch", entityId: id,
    detail: `Branch "${row.name}" updated`,
  });
  return json({ ok: true });
}
