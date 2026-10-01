import { NextRequest } from "next/server";
import { eq, and, desc, sql } from "drizzle-orm";
import { approvalRequests } from "@/db/schema";
import { json } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";

// GET /api/approvals?status=PENDING — the approvals inbox (approvals perm)
export async function GET(req: NextRequest) {
  const gate = await requirePermission("approvals");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const status = sp.get("status")?.toUpperCase();
  const page = Math.max(1, parseInt(sp.get("page") || "1", 10));
  const perPage = Math.min(100, Math.max(1, parseInt(sp.get("perPage") || "20", 10)));

  const conds = [eq(approvalRequests.companyId, companyId)];
  if (status && ["PENDING", "APPROVED", "REJECTED", "CANCELLED"].includes(status))
    conds.push(eq(approvalRequests.status, status));

  const rows = await db
    .select()
    .from(approvalRequests)
    .where(and(...conds))
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(perPage)
    .offset((page - 1) * perPage);
  const total = await db
    .select({ n: sql<number>`count(*)` })
    .from(approvalRequests)
    .where(and(...conds));
  return json({
    data: rows.map((r) => ({
      id: r.id,
      docType: r.docType,
      status: r.status,
      docId: r.docId,
      docNo: r.docNo,
      partyName: r.partyName,
      amountPaisa: (r.amountPaisa ?? 0n).toString(),
      requestedByName: r.requestedByName,
      requestedAt: r.requestedAt,
      decidedByName: r.decidedByName,
      decidedAt: r.decidedAt,
      decisionComment: r.decisionComment,
      payload: safePayload(r.payload),
    })),
    total: total[0]?.n ?? 0,
    page,
    perPage,
  });
}

/** The inbox needs amounts + a one-line summary, not the full staged payload. */
function safePayload(raw: string | null): { lines: number; memo?: string; kind?: string } {
  try {
    const p = JSON.parse(raw || "{}") as {
      items?: unknown[];
      lines?: unknown[];
      lineBatches?: unknown[];
      memo?: string;
      notes?: string;
      kind?: string;
      allocations?: unknown[];
    };
    const lines = Array.isArray(p.items)
      ? p.items.length
      : Array.isArray(p.lines)
        ? p.lines.length
        : Array.isArray(p.lineBatches)
          ? p.lineBatches.length
          : Array.isArray(p.allocations)
            ? p.allocations.length
            : 0;
    const memo = typeof p.memo === "string" ? p.memo : typeof p.notes === "string" ? p.notes : undefined;
    return { lines, memo, kind: typeof p.kind === "string" ? p.kind : undefined };
  } catch {
    return { lines: 0 };
  }
}
