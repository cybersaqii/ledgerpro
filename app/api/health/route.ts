import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { companies } from "@/db/schema";

// GET /api/health — public liveness probe for uptime monitoring. No auth.
export async function GET() {
  try {
    await db.select({ id: companies.id }).from(companies).limit(1);
    return NextResponse.json({ ok: true, time: new Date().toISOString(), db: "up" });
  } catch (e) {
    console.error("health check: db unreachable", e);
    return NextResponse.json({ ok: false, db: "down" }, { status: 503 });
  }
}
