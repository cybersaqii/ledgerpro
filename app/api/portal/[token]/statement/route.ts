import { NextRequest } from "next/server";
import { json, portalGate } from "@/lib/portal-route";
import { db } from "@/lib/route-helpers";
import { getPortalLedger } from "@/lib/portal";
import { toApiError } from "@/lib/errors";

// GET /api/portal/[token]/statement?from=YYYY-MM-DD&to=YYYY-MM-DD
// Party statement: opening balance + every ledger line + closing balance.
// The public page renders this with print CSS for PDF download.
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  try {
    const { token } = await params;
    const gate = await portalGate(req, token);
    if (!gate.ok) return gate.response;
    const { ctx } = gate;
    const sp = req.nextUrl.searchParams;
    const parseDay = (v: string | null, end: boolean): number | undefined => {
      if (!v) return undefined;
      const t = Date.parse(`${v}T00:00:00Z`);
      if (isNaN(t)) return undefined;
      return end ? t + 86400000 : t;
    };
    const from = parseDay(sp.get("from"), false);
    const to = parseDay(sp.get("to"), true);
    const stmt = await getPortalLedger(db, ctx.token.companyId, ctx.party.id, from, to);
    return json({
      partyName: ctx.party.name,
      partyKind: ctx.party.kind,
      companyName: ctx.company.tradeName || ctx.company.name,
      from: sp.get("from") ?? null,
      to: sp.get("to") ?? null,
      ...stmt,
    });
  } catch (e) {
    return toApiError(e, { route: "/api/portal/[token]/statement" });
  }
}
