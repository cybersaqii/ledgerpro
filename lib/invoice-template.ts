import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { settings } from "@/db/schema";
import type { Db, DbTx } from "./db";

// Module 6.5 — invoice template designer storage. The branding defaults that
// document print views read when rendering invoices/challans:
//   invoice_tpl_primary_color — accent colour for headers (hex, e.g. #0f766e)
//   invoice_tpl_terms           — default terms & conditions block
//   invoice_tpl_signature_url   — HTTPS URL of the authorised-signature image
//   invoice_tpl_qr_enabled      — "1" prints a QR (doc URL) on the invoice
//   invoice_tpl_show_logo       — "1" prints the company logo (default on)

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export const templateSchema = z.object({
  primaryColor: z.string().trim().regex(HEX_COLOR, "Colour must be a hex code like #0f766e."),
  terms: z.string().max(2000).optional().or(z.literal("")),
  signatureUrl: z
    .string()
    .trim()
    .max(500)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^https:\/\/[^/\s]+\.[^/\s]+/i.test(v), {
      message: "Signature must be a valid HTTPS URL.",
    }),
  qrEnabled: z.boolean(),
  showLogo: z.boolean(),
});

export type TemplateSettings = z.infer<typeof templateSchema>;

export const TEMPLATE_DEFAULTS: TemplateSettings = {
  primaryColor: "#0f766e",
  terms: "",
  signatureUrl: "",
  qrEnabled: false,
  showLogo: true,
};

const KEY_OF: Record<keyof TemplateSettings, string> = {
  primaryColor: "invoice_tpl_primary_color",
  terms: "invoice_tpl_terms",
  signatureUrl: "invoice_tpl_signature_url",
  qrEnabled: "invoice_tpl_qr_enabled",
  showLogo: "invoice_tpl_show_logo",
};

export async function readTemplateSettings(tx: Db | DbTx, companyId: string): Promise<TemplateSettings> {
  const all = await tx
    .select({ key: settings.key, value: settings.value })
    .from(settings)
    .where(eq(settings.companyId, companyId));
  const byKey = new Map(all.map((r) => [r.key, r.value ?? ""]));
  const get = (k: string) => (byKey.has(k) ? byKey.get(k)! : null);
  const bool = (v: string | null, d: boolean) => (v === null ? d : v === "1");
  return {
    primaryColor: get(KEY_OF.primaryColor) ?? TEMPLATE_DEFAULTS.primaryColor,
    terms: get(KEY_OF.terms) ?? TEMPLATE_DEFAULTS.terms,
    signatureUrl: get(KEY_OF.signatureUrl) ?? TEMPLATE_DEFAULTS.signatureUrl,
    qrEnabled: bool(get(KEY_OF.qrEnabled), TEMPLATE_DEFAULTS.qrEnabled),
    showLogo: bool(get(KEY_OF.showLogo), TEMPLATE_DEFAULTS.showLogo),
  };
}

export async function writeTemplateSettings(
  tx: Db | DbTx,
  companyId: string,
  d: TemplateSettings
): Promise<void> {
  const store: Record<keyof TemplateSettings, string> = {
    primaryColor: d.primaryColor,
    terms: d.terms || "",
    signatureUrl: d.signatureUrl || "",
    qrEnabled: d.qrEnabled ? "1" : "0",
    showLogo: d.showLogo ? "1" : "0",
  };
  for (const k of Object.keys(store) as (keyof typeof store)[]) {
    const key = KEY_OF[k];
    const value = store[k];
    const existing = await tx
      .select({ id: settings.id })
      .from(settings)
      .where(and(eq(settings.companyId, companyId), eq(settings.key, key)))
      .limit(1);
    if (existing[0]) {
      await tx.update(settings).set({ value, updatedAt: new Date() }).where(eq(settings.id, existing[0].id));
    } else {
      await tx
        .insert(settings)
        .values({ id: crypto.randomUUID(), companyId, key, value });
    }
  }
}
