import { NextRequest } from "next/server";
import { GET as customerOutstanding } from "../customer-outstanding/route";

// GET /api/reports/supplier-outstanding — same engine as customer-outstanding,
// forced to kind=SUPPLIER (purchase BILLs).
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  url.searchParams.set("kind", "SUPPLIER");
  const forced = new NextRequest(url, req);
  return customerOutstanding(forced);
}
