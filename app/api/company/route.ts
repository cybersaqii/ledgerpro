import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { companies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, requireOwner, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { businessTypeLabel } from "@/lib/business-types";

const companySchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z.string().trim().max(120).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(60).optional().or(z.literal("")),
  ntn: z.string().trim().max(30).optional().or(z.literal("")),
  businessType: z.enum(["WHOLESALE", "RETAIL", "DISTRIBUTION", "PHARMACY", "CLINIC", "RESTAURANT", "SERVICES", "MANUFACTURING", "OTHER"]),
});

// GET /api/company — current company's profile
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const rows = await db.select().from(companies).where(eq(companies.id, gate.companyId)).limit(1);
  const c = rows[0];
  if (!c) return err("Company not found.", 404);
  return json({
    data: {
      id: c.id, name: c.name, email: c.email, phone: c.phone,
      address: c.address, city: c.city, ntn: c.ntn,
      businessType: c.businessType, businessTypeLabel: businessTypeLabel(c.businessType),
      currency: c.currency,
      lockedUntil: c.lockedUntil ? c.lockedUntil.toISOString().slice(0, 10) : null,
    },
  });
}

// PUT /api/company — update profile
export async function PUT(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const body = await req.json().catch(() => null);
  const parsed = companySchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const d = parsed.data;
  await db.update(companies).set({
    name: d.name,
    email: d.email || null,
    phone: d.phone || null,
    address: d.address || null,
    city: d.city || null,
    ntn: d.ntn || null,
    businessType: d.businessType,
    updatedAt: new Date(),
  }).where(eq(companies.id, gate.companyId));
  await logAudit(db, {
    companyId: gate.companyId, userId: gate.session.uid, userName: gate.session.name,
    action: "settings.updated", entity: "company", entityId: gate.companyId,
    detail: `Business profile updated ("${d.name}")`,
  });
  return json({ ok: true });
}
