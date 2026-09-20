import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { backups } from "@/db/schema";
import { err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireOwner } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { requirePro } from "@/lib/billing-guards";

// GET /api/backups/[id] — download one stored backup as JSON (owner-only, PRO feature).
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;
  const { id } = await ctx.params;
  try {
    const rows = await db
      .select({ payload: backups.payload, createdAt: backups.createdAt })
      .from(backups)
      .where(and(eq(backups.id, id), eq(backups.companyId, gate.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return err("Backup not found.", 404);
    const d = row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt);
    const stamp = isNaN(d.getTime()) ? "backup" : d.toISOString().slice(0, 10);
    return new NextResponse(row.payload, {
      headers: {
        "content-type": "application/json",
        "content-disposition": `attachment; filename="ledgerpro-backup-${stamp}.json"`,
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/backups/[id]", companyId: gate.companyId });
  }
}
