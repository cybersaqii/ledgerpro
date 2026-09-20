import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { setSupportRequestStatus } from "@/lib/support";

// PATCH /api/admin/support/[id] — platform admin: { status: "OPEN" | "RESOLVED" }.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  try {
    const { id } = await params;
    const body = await req.json().catch(() => null);
    const status = String(body?.status ?? "").toUpperCase();
    if (status !== "OPEN" && status !== "RESOLVED") return err("Status must be OPEN or RESOLVED.", 422);
    const ok = await setSupportRequestStatus(db, id, status);
    if (!ok) return err("Request not found.", 404);
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/support/[id]", companyId: null });
  }
}
