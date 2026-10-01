import { NextRequest } from "next/server";
import { z } from "zod";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { listAllowlist, addAllowlistEntry } from "@/lib/ip-allowlist";

// GET /api/security/ip-allowlist — list entries. An empty list = feature OFF (fail-open).
// POST /api/security/ip-allowlist — add an entry {cidr, label?}.
// Permission: settings.
export async function GET() {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  try {
    const rows = await listAllowlist(db, gate.companyId);
    return json({
      data: {
        enabled: rows.length > 0,
        entries: rows.map((r) => ({
          id: r.id,
          cidr: r.cidr,
          label: r.label,
          createdAt: r.createdAt.toISOString(),
        })),
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-allowlist" });
  }
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  try {
    const body = await req.json().catch(() => null);
    const parsed = z
      .object({ cidr: z.string().min(1).max(60), label: z.string().trim().max(80).optional().or(z.literal("")) })
      .safeParse(body);
    if (!parsed.success) return err("Enter a valid IP address or CIDR.", 422, "VALIDATION_ERROR");
    const id = await db.transaction((tx) =>
      addAllowlistEntry(tx, companyId, parsed.data.cidr, parsed.data.label || null, session.uid)
    );
    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "security.ip_allowlist.added",
      entity: "company",
      entityId: companyId,
      detail: `Allowlisted ${parsed.data.cidr}${parsed.data.label ? ` (${parsed.data.label})` : ""}`,
      ip: clientIp(req),
    });
    return json({ data: { id } }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/security/ip-allowlist" });
  }
}
