import { desc } from "drizzle-orm";
import { errorLogs } from "@/db/schema";
import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { requireOwner } from "@/lib/route-helpers";

// GET /api/system/errors — owner-only: last 20 server-side errors, newest first.
export async function GET() {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const rows = await db
    .select({
      id: errorLogs.id,
      route: errorLogs.route,
      message: errorLogs.message,
      createdAt: errorLogs.createdAt,
    })
    .from(errorLogs)
    .orderBy(desc(errorLogs.createdAt))
    .limit(20);
  return json({ data: rows });
}
