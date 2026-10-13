import { NextRequest } from "next/server";
import { z } from "zod";
import { desc, sql } from "drizzle-orm";
import { json, err } from "@/lib/api";
import { requirePlatformAdmin } from "@/lib/billing-guards";
import { db } from "@/lib/route-helpers";
import { companies, users } from "@/db/schema";
import { activatePlan } from "@/lib/billing-guards";
import { getAccessLevel, trialDaysLeft, proDaysLeft, normalizePlan } from "@/lib/entitlements";
import { logAudit } from "@/lib/audit";

// GET /api/admin/billing/companies — all companies with subscription status
export async function GET() {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;

  const rows = await db
    .select({
      id: companies.id,
      name: companies.name,
      email: companies.email,
      phone: companies.phone,
      plan: companies.plan,
      trialEndsAt: companies.trialEndsAt,
      proExpiresAt: companies.proExpiresAt,
      createdAt: companies.createdAt,
      ownerName: sql<string>`(SELECT name FROM users WHERE users.company_id = ${companies.id} AND users.role = 'OWNER' LIMIT 1)`,
      ownerEmail: sql<string>`(SELECT email FROM users WHERE users.company_id = ${companies.id} AND users.role = 'OWNER' LIMIT 1)`,
      userCount: sql<number>`(SELECT COUNT(*) FROM users WHERE users.company_id = ${companies.id})`,
    })
    .from(companies)
    .orderBy(desc(companies.createdAt));

  const now = new Date();
  const data = rows.map((r) => {
    const c = {
      trialEndsAt: r.trialEndsAt ? new Date(r.trialEndsAt as unknown as string) : null,
      proExpiresAt: r.proExpiresAt ? new Date(r.proExpiresAt as unknown as string) : null,
      plan: r.plan,
    };
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      phone: r.phone,
      plan: r.plan ?? "FREE",
      level: getAccessLevel(c as never, now),
      trialDaysLeft: trialDaysLeft(c as never, now),
      proDaysLeft: proDaysLeft(c as never, now),
      trialEndsAt: r.trialEndsAt ? new Date(r.trialEndsAt as unknown as string).toISOString() : null,
      proExpiresAt: r.proExpiresAt ? new Date(r.proExpiresAt as unknown as string).toISOString() : null,
      createdAt: r.createdAt ? new Date(r.createdAt as unknown as string).toISOString() : null,
      ownerName: r.ownerName,
      ownerEmail: r.ownerEmail,
      userCount: Number(r.userCount ?? 0),
    };
  });
  return json({ data });
}

const extendSchema = z.object({
  companyId: z.string().min(1),
  plan: z.enum(["STARTER", "PROFESSIONAL", "ENTERPRISE"]),
  months: z.number().int().min(1).max(36),
});

// POST /api/admin/billing/companies — extend/renew a subscription
export async function POST(req: NextRequest) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const { session } = gate;

  const body = await req.json().catch(() => ({}));
  const b = extendSchema.safeParse(body);
  if (!b.success) return err("Invalid input.", 422);

  try {
    const expires = await db.transaction(async (tx) => {
      return activatePlan(tx, b.data.companyId, normalizePlan(b.data.plan), b.data.months);
    });
    await logAudit(db, {
      companyId: b.data.companyId,
      userId: session.uid, userName: session.name,
      action: "admin.subscription.extend",
      entity: "company",
      entityId: b.data.companyId,
      detail: `Extended ${b.data.plan} by ${b.data.months} months`,
    });
    return json({ data: { proExpiresAt: expires.toISOString() } });
  } catch (e) {
    return err(e instanceof Error ? e.message : "Failed.", 422);
  }
}
