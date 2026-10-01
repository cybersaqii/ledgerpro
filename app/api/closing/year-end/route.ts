import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { closeYear, getCloseStatus } from "@/lib/year-end";
import { logAudit } from "@/lib/audit";

// GET /api/closing/year-end — close status: past closes + candidate fiscal years.
export async function GET() {
  const gate = await requirePermission("period_lock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const status = await getCloseStatus(db, companyId);
  return json({ data: status });
}

const closeSchema = z.object({
  // "2025-26". Defaults to the most recently ended fiscal year.
  fiscalYear: z.string().regex(/^\d{4}-\d{2}$/, "Invalid fiscal year.").optional(),
});

// POST /api/closing/year-end — run the year-end close for a fiscal year.
// Zeroes revenue/expense accounts into Retained Earnings (3003) and locks
// the year. UNIQUE(company_id, fiscal_year) makes repeats a 409, never a
// double post.
export async function POST(req: NextRequest) {
  const gate = await requirePermission("period_lock");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = closeSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid close request.", 422);

  try {
    let fiscalYear = b.data.fiscalYear;
    if (!fiscalYear) {
      const status = await getCloseStatus(db, companyId);
      const ended = status.candidates.filter((c) => !c.current && !c.closed);
      fiscalYear = ended[0]?.fiscalYear;
      if (!fiscalYear) return err("No unclosed fiscal year available.", 422, "NO_YEAR_TO_CLOSE");
    }

    const { entryId, docNo, netIncome } = await db.transaction(async (tx) =>
      closeYear(tx, { companyId, fiscalYear: fiscalYear!, closedById: session.uid })
    );

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "year.closed", entity: "year_end_close", entityId: entryId ?? fiscalYear,
      detail: `Closed FY ${fiscalYear} (net Rs ${(netIncome >= 0n ? netIncome : -netIncome) / 100n}${netIncome < 0n ? " loss" : ""})`,
    });
    return json(
      { data: { fiscalYear, entryId, docNo, netIncome: netIncome.toString() } },
      { status: 201 }
    );
  } catch (e) {
    return toApiError(e, { route: "/api/closing/year-end", companyId });
  }
}
