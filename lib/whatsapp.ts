// WhatsApp deep-link helpers (wa.me). No API keys needed — opens a chat with
// a pre-filled message. Phone numbers are normalized to international format
// (Pakistani 03xx -> 92...).

/** Normalize a phone number to international digits for wa.me. */
export function waPhone(phone: string | null | undefined): string {
  const digits = (phone || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("0")) return `92${digits.slice(1)}`;
  return digits;
}

/** wa.me link with a pre-filled message. Falls back to wa.me share when no number. */
export function waLink(phone: string | null | undefined, message: string): string {
  const intl = waPhone(phone);
  const base = intl ? `https://wa.me/${intl}` : "https://wa.me";
  return `${base}?text=${encodeURIComponent(message)}`;
}

/** Payment reminder text for an overdue party. Amounts are pre-formatted strings. */
export function reminderText(opts: {
  businessName: string;
  partyName: string;
  totalOverdue: string;
  oldestDays: number;
  invoiceCount: number;
}): string {
  const { businessName, partyName, totalOverdue, oldestDays, invoiceCount } = opts;
  return (
    `Assalam-o-Alaikum ${partyName},\n` +
    `*${businessName}* se yaad-dihani: aap ke khaate mein *${totalOverdue}* baqaya hai ` +
    `(${invoiceCount} bill${invoiceCount === 1 ? "" : "s"}${oldestDays > 0 ? `, sab se purana ${oldestDays} din se` : ""}).\n` +
    `Barah-e-karam jald adaigi farma dein. Shukriya!`
  );
}
