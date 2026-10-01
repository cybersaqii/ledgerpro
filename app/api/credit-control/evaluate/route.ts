import { eq, and } from "drizzle-orm";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { parties } from "@/db/schema";
import { evaluateCreditHold } from "@/lib/credit-control";

// POST /api/credit-control/evaluate — on-demand sweep: re-evaluate the
// credit rules against every active customer, applying / lifting holds and
// refreshing risk categories. Permission: parties.
export async function POST() {
  const gate = await requirePermission("parties");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const customers = await db
      .select({ id: parties.id })
      .from(parties)
      .where(
        and(
          eq(parties.companyId, companyId),
          eq(parties.kind, "CUSTOMER"),
          eq(parties.isActive, true)
        )
      );
    let held = 0;
    let ok = 0;
    for (const c of customers) {
      const d = await db.transaction((tx) =>
        evaluateCreditHold(tx, { companyId, partyId: c.id, actor: session.uid })
      );
      if (d.held) held++;
      else ok++;
    }
    return json({ data: { evaluated: customers.length, held, ok } });
  } catch (e) {
    return toApiError(e, { route: "/api/credit-control/evaluate" });
  }
}
