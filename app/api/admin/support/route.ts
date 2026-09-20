import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { listSupportRequests } from "@/lib/support";

// GET /api/admin/support?status=OPEN|RESOLVED|ALL — platform admin: list requests.
export async function GET(req: NextRequest) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  try {
    const status = new URL(req.url).searchParams.get("status")?.toUpperCase();
    if (status && !["OPEN", "RESOLVED", "ALL"].includes(status)) return err("Bad status filter.", 422);
    const rows = await listSupportRequests(db, (status as "OPEN" | "RESOLVED" | "ALL") || "OPEN");
    return json({
      data: rows.map((r) => ({
        id: r.id, name: r.name, email: r.email, subject: r.subject,
        message: r.message, status: r.status,
        createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
      })),
    });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/support", companyId: null });
  }
}
