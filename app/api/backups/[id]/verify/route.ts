import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { backups } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requireOwner } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { requirePro } from "@/lib/billing-guards";
import { validateBackupPayload } from "@/lib/backup";

// POST /api/backups/[id]/verify — dry-run restore check of one stored backup.
// Parses and validates the payload exactly as a restore would read it.
// Makes zero writes — the books are never touched.
export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;
  const { id } = await ctx.params;
  try {
    const rows = await db
      .select({ payload: backups.payload })
      .from(backups)
      .where(and(eq(backups.id, id), eq(backups.companyId, gate.companyId)))
      .limit(1);
    const row = rows[0];
    if (!row) return err("Backup not found.", 404);
    return json({ data: validateBackupPayload(row.payload) });
  } catch (e) {
    return toApiError(e, { route: "/api/backups/[id]/verify", companyId: gate.companyId });
  }
}
