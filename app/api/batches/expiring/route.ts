import { expiryAlerts } from "@/lib/batches";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/batches/expiring — batches already expired or expiring within 30 days.
export async function GET() {
  const gate = await requirePermission("stock");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { expired, expiring } = await expiryAlerts(db, companyId, 30);
  const shape = (r: (typeof expired)[number]) => ({
    id: r.id,
    productId: r.productId,
    productName: r.productName,
    unit: r.unit,
    batchNo: r.batchNo,
    expiryDate: r.expiryDate,
    qtyThousandths: r.qtyThousandths.toString(),
  });
  return json({ data: { expired: expired.map(shape), expiring: expiring.map(shape) } });
}
