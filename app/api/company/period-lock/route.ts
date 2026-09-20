import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { companies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireOwner, db, parseDateOnly } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";

// PUT /api/company/period-lock — owner sets or clears the accounting period lock.
// { lockedUntil: "YYYY-MM-DD" | null } — books are locked through that date:
// no entries dated on or before it can be added or changed.
export async function PUT(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => null);
  const raw = body?.lockedUntil;

  let lockedUntil: Date | null = null;
  if (raw !== null && raw !== undefined && String(raw).trim() !== "") {
    try {
      lockedUntil = parseDateOnly(String(raw).trim());
    } catch {
      return err("Enter a valid date (YYYY-MM-DD).", 422);
    }
    if (lockedUntil.getTime() > Date.now()) {
      return err("The lock date cannot be in the future.", 422);
    }
  }

  await db
    .update(companies)
    .set({ lockedUntil, updatedAt: new Date() })
    .where(eq(companies.id, companyId));

  await logAudit(db, {
    companyId, userId: session.uid, userName: session.name,
    action: "settings.period_lock", entity: "company", entityId: companyId,
    detail: lockedUntil
      ? `Accounting period locked up to ${lockedUntil.toISOString().slice(0, 10)}`
      : "Accounting period lock cleared",
  });
  return json({ ok: true, lockedUntil: lockedUntil ? lockedUntil.toISOString().slice(0, 10) : null });
}
