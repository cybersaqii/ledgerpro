// Central brand config — rename the product here and it updates everywhere.
export const brand = {
  name: "LedgerProSolution",
  tagline: "Complete hisaab-kitab for every business",
  description:
    "Sales, purchases, stock, payments and full double-entry accounts — tailored to your trade.",
  accent: "emerald",
  // WhatsApp support: international format without "+" (e.g. "923001234567").
  // Users tap to chat with pre-filled issue reports (screenshots/videos attach in WhatsApp).
  supportWhatsApp: "923238737464",
  // Public contact details (landing footer, legal pages). The email is the
  // single source of truth — lib/support.ts defaults read it too, and the
  // production platform_settings value must match it (Sunday sweep 2026-11-08).
  supportEmail: "support@ledgerprosolution.com",
  supportPhone: "03238737464",
} as const;

/** wa.me deep link with pre-filled text. Returns null when no number is configured. */
export function whatsappLink(text: string): string | null {
  if (!brand.supportWhatsApp) return null;
  return `https://wa.me/${brand.supportWhatsApp}?text=${encodeURIComponent(text)}`;
}
