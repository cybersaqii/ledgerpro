import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { companies, settings, users } from "@/db/schema";

import { json, err } from "@/lib/api";
import { requireCompany, requireOwner, requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import { businessTypeLabel } from "@/lib/business-types";
import { verifyPassword, destroySession } from "@/lib/auth";
import { deleteCompanyData } from "@/lib/company-delete";
import { reportError, toApiError } from "@/lib/errors";

const FISCAL_START_RE = /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/;

const companySchema = z.object({
  name: z.string().trim().min(2).max(80),
  tradeName: z.string().trim().max(80).optional().or(z.literal("")),
  email: z.string().trim().max(120).optional().or(z.literal("")),
  phone: z.string().trim().max(30).optional().or(z.literal("")),
  address: z.string().trim().max(300).optional().or(z.literal("")),
  city: z.string().trim().max(60).optional().or(z.literal("")),
  ntn: z.string().trim().max(30).optional().or(z.literal("")),
  strn: z.string().trim().max(30).optional().or(z.literal("")),
  bankInfo: z.string().trim().max(500).optional().or(z.literal("")),
  invoiceFooter: z.string().trim().max(500).optional().or(z.literal("")),
  businessType: z.enum(["WHOLESALE", "RETAIL", "DISTRIBUTION", "PHARMACY", "CLINIC", "RESTAURANT", "SERVICES", "MANUFACTURING", "OTHER"]),
  defaultInvoiceFormat: z.enum(["a4", "80mm", "challan"]).default("80mm"),
  invoiceTitle: z.string().trim().max(60).optional().or(z.literal("")),
  invoiceShowLogo: z.boolean().default(true),
  invoiceTerms: z.string().trim().max(1000).optional().or(z.literal("")),
  invoiceShowPaid: z.boolean().default(true),
  invoiceHeaderNote: z.string().trim().max(300).optional().or(z.literal("")),
  // Module 6.1: the month-day the fiscal year starts on (drives year-end
  // close labels). Stored in the company settings table.
  fiscalYearStart: z.string().regex(FISCAL_START_RE, "Use MM-DD, e.g. 07-01.").default("07-01"),
});

// GET /api/company — current company's profile
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const rows = await db.select().from(companies).where(eq(companies.id, gate.companyId)).limit(1);
  const c = rows[0];
  if (!c) return err("Company not found.", 404);
  const fmtRows = await db.select().from(companies).where(eq(companies.id, gate.companyId)).limit(1);
  const defaultInvoiceFormat = fmtRows[0]?.defaultInvoiceFormat ?? "80mm";
  const fyRows = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.companyId, gate.companyId), eq(settings.key, "fiscal_year_start")))
    .limit(1);
  return json({
    data: {
      id: c.id, name: c.name, tradeName: c.tradeName, email: c.email, phone: c.phone,
      address: c.address, city: c.city, ntn: c.ntn, strn: c.strn,
      bankInfo: c.bankInfo, invoiceFooter: c.invoiceFooter, logoUrl: c.logoUrl,
      businessType: c.businessType, businessTypeLabel: businessTypeLabel(c.businessType),
      currency: c.currency,
      defaultInvoiceFormat: String(defaultInvoiceFormat),
      invoiceTitle: c.invoiceTitle, invoiceShowLogo: c.invoiceShowLogo,
      invoiceTerms: c.invoiceTerms, invoiceShowPaid: c.invoiceShowPaid,
      invoiceHeaderNote: c.invoiceHeaderNote,
      fiscalYearStart: fyRows[0]?.value || "07-01",
      lockedUntil: c.lockedUntil ? c.lockedUntil.toISOString().slice(0, 10) : null,
    },
  });
}

// PUT /api/company — update profile (owner, or staff with the settings permission)
export async function PUT(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const body = await req.json().catch(() => null);
  const parsed = companySchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422, "VALIDATION_ERROR");
  const d = parsed.data;
  const [before] = await db.select().from(companies).where(eq(companies.id, gate.companyId)).limit(1);
  await db.update(companies).set({
    name: d.name,
    tradeName: d.tradeName || null,
    email: d.email || null,
    phone: d.phone || null,
    address: d.address || null,
    city: d.city || null,
    ntn: d.ntn || null,
    strn: d.strn || null,
    bankInfo: d.bankInfo || null,
    invoiceFooter: d.invoiceFooter || null,
    invoiceTitle: d.invoiceTitle || null,
    invoiceShowLogo: d.invoiceShowLogo,
    invoiceTerms: d.invoiceTerms || null,
    invoiceShowPaid: d.invoiceShowPaid,
    invoiceHeaderNote: d.invoiceHeaderNote || null,
    businessType: d.businessType,
    updatedAt: new Date(),
  }).where(eq(companies.id, gate.companyId));
  await db.update(companies).set({ defaultInvoiceFormat: d.defaultInvoiceFormat }).where(eq(companies.id, gate.companyId));
  // Module 6.1: fiscal year start lives in the settings table (upsert).
  const fyExisting = await db
    .select({ id: settings.id })
    .from(settings)
    .where(and(eq(settings.companyId, gate.companyId), eq(settings.key, "fiscal_year_start")))
    .limit(1);
  if (fyExisting[0]) {
    await db.update(settings).set({ value: d.fiscalYearStart, updatedAt: new Date() }).where(eq(settings.id, fyExisting[0].id));
  } else {
    await db.insert(settings).values({
      id: crypto.randomUUID(),
      companyId: gate.companyId,
      key: "fiscal_year_start",
      value: d.fiscalYearStart,
    });
  }
  await logAudit(db, {
    companyId: gate.companyId, userId: gate.session.uid, userName: gate.session.name,
    action: "settings.updated", entity: "company", entityId: gate.companyId,
    detail: `Business profile updated ("${d.name}")`,
    ip: clientIp(req),
    oldValues: before
      ? { name: before.name, tradeName: before.tradeName, ntn: before.ntn, strn: before.strn }
      : null,
    newValues: { name: d.name, tradeName: d.tradeName || null, ntn: d.ntn || null, strn: d.strn || null, fiscalYearStart: d.fiscalYearStart },
  });
  return json({ ok: true });
}

const deleteSchema = z.object({
  companyName: z.string().trim().min(1).max(80),
  password: z.string().min(1).max(200),
});

// DELETE /api/company — owner-only: permanently delete the whole company.
// Body: { companyName (typed confirmation), password (re-entry) }.
// Writes a `company.deleted` entry to the global error log (companyId NULL so
// it survives the wipe), deletes every company row in one transaction, then
// signs the user out. Available on FREE and PRO — it is a data right, not a feature.
export async function DELETE(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  try {
    const body = await req.json().catch(() => null);
    const parsed = deleteSchema.safeParse(body);
    if (!parsed.success) return err("Type your company name and current password to confirm.", 422);

    const [company] = await db.select().from(companies).where(eq(companies.id, gate.companyId)).limit(1);
    if (!company) return err("Company not found.", 404);
    if (parsed.data.companyName !== company.name) {
      return err("The typed name does not match your company name.", 422);
    }
    const [user] = await db.select().from(users).where(eq(users.id, gate.session.uid)).limit(1);
    if (!user || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
      return err("Password is incorrect.", 401);
    }

    // Audit BEFORE the wipe, into the global log with companyId NULL so it survives.
    await reportError({
      route: "/api/company",
      message: `company.deleted id=${company.id} name=${company.name}`,
      companyId: null,
    });

    await db.transaction((tx) => deleteCompanyData(tx, gate.companyId));
    await destroySession();
    return json({ ok: true });
  } catch (e) {
    return toApiError(e, { route: "/api/company", companyId: null });
  }
}
