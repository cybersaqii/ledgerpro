import { eq } from "drizzle-orm";
import { accounts } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { glSums } from "@/lib/reports";

// GET /api/reports/trial-balance
export async function GET() {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;

  const sums = await glSums(db, companyId);
  const accs = await db.select().from(accounts).where(eq(accounts.companyId, companyId));

  const lines = accs
    .map((a) => {
      const s = sums.get(a.code);
      const debit = s?.debit ?? 0n;
      const credit = s?.credit ?? 0n;
      return {
        code: a.code,
        name: a.name,
        type: a.type,
        debit: debit.toString(),
        credit: credit.toString(),
      };
    })
    .filter((l) => l.debit !== "0" || l.credit !== "0");

  const totalDebit = lines.reduce((a, l) => a + BigInt(l.debit), 0n);
  const totalCredit = lines.reduce((a, l) => a + BigInt(l.credit), 0n);

  return json({
    lines,
    totalDebit: totalDebit.toString(),
    totalCredit: totalCredit.toString(),
    balanced: totalDebit === totalCredit,
  });
}
