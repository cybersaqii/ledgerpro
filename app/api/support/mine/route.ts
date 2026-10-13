import { NextRequest } from "next/server";
import { desc, eq } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { db } from "@/lib/db";
import { requireCompany } from "@/lib/route-helpers";
import { supportRequests } from "@/db/schema";
import { validateSupportInput, createSupportRequest } from "@/lib/support";
import { toApiError, UserError } from "@/lib/errors";

// GET /api/support/mine — logged-in company's support requests
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;

  const rows = await db
    .select({
      id: supportRequests.id,
      subject: supportRequests.subject,
      message: supportRequests.message,
      status: supportRequests.status,
      createdAt: supportRequests.createdAt,
    })
    .from(supportRequests)
    .where(eq(supportRequests.companyId, gate.companyId))
    .orderBy(desc(supportRequests.createdAt))
    .limit(50);
  return json({ data: rows });
}

// POST /api/support/mine — logged-in user submits (name/email auto-filled)
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;

  try {
    const body = await req.json().catch(() => null);
    const input = validateSupportInput({
      name: session.name || "User",
      email: session.email || "",
      subject: body?.subject,
      message: body?.message,
    });
    const id = await createSupportRequest(db, {
      ...input,
      companyId,
      userId: session.uid,
    });
    return json({ ok: true, id });
  } catch (e) {
    if (e instanceof UserError) return err(e.message, e.status, e.code);
    return toApiError(e, { route: "/api/support/mine", companyId });
  }
}
