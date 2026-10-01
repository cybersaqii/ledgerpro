import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { reverseJournal } from "@/lib/journal-vouchers";
import { logAudit } from "@/lib/audit";

const reverseSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
});

// POST /api/journal-vouchers/[id]/reverse — one-click reverse of a MANUAL
// voucher. Posts a mirror JV; the original is never edited or deleted.
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = reverseSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid reversal.", 422);

  try {
    const { entryId, docNo } = await db.transaction(async (tx) =>
      reverseJournal(tx, {
        companyId,
        entryId: id,
        date: b.data.date ? parseDateOnly(b.data.date) : undefined,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "journal.reversed", entity: "journal", entityId: entryId,
      detail: `Reversed voucher ${id} as ${docNo}`,
    });
    return json({ data: { id: entryId, docNo } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/journal-vouchers/[id]/reverse", companyId });
  }
}
