// Central brand config — rename the product here and it updates everywhere.
export const brand = {
  name: "LedgerProSolution",
  tagline: "Complete hisaab-kitab for every business",
  description:
    "Sales, purchases, stock, payments and full double-entry accounts — tailored to your trade.",
  accent: "emerald",
  // WhatsApp support: international format without "+" (e.g. "923001234567").
  // Users tap to chat with pre-filled issue reports (screenshots/videos attach in WhatsApp).
  supportWhatsApp: "",
} as const;

/** wa.me deep link with pre-filled text. Returns null when no number is configured. */
export function whatsappLink(text: string): string | null {
  if (!brand.supportWhatsApp) return null;
  return `https://wa.me/${brand.supportWhatsApp}?text=${encodeURIComponent(text)}`;
}
