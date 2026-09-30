/**
 * Email infrastructure for LedgerProSolution — sends transactional email via
 * the Resend HTTP API using plain global fetch (no extra dependencies).
 *
 * Env:
 *   RESEND_API_KEY — Resend API key. When missing/empty, sends are skipped
 *                    (warn + { ok: false, skipped: true }), never thrown.
 *   EMAIL_FROM     — default sender, e.g. "LedgerProSolution <noreply@ledgerprosolution.com>".
 *
 * SECURITY: never log email bodies — they may contain OTP codes. Logs carry
 * recipient + subject only.
 */

import { brand } from "@/lib/brand";

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendEmailResult {
  ok: boolean;
  skipped?: boolean;
  id?: string;
}

/**
 * Branded email header — a slim emerald band with the product wordmark.
 * Prepend to every transactional email's HTML so the brand reads the same
 * in the inbox as it does in the app.
 */
export function brandEmailHeader(): string {
  return `<div style="background:linear-gradient(135deg,#047857,#10b981);border-radius:12px 12px 0 0;padding:18px 24px;">
    <span style="color:#ffffff;font-family:sans-serif;font-size:20px;font-weight:800;letter-spacing:-0.02em;">LedgerPro<span style="color:#a7f3d0;">Solution</span></span>
    <span style="display:block;color:#d1fae5;font-family:sans-serif;font-size:12px;margin-top:2px;">${brand.tagline}</span>
  </div>`;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = (process.env.RESEND_API_KEY ?? "").trim();
  const from = process.env.EMAIL_FROM ?? `${brand.name} <noreply@ledgerprosolution.com>`;

  if (!apiKey) {
    console.warn(`[email] RESEND_API_KEY not set — skipping send to ${input.to}`);
    return { ok: false, skipped: true };
  }

  const body: Record<string, unknown> = {
    from,
    to: [input.to],
    subject: input.subject,
    html: input.html,
  };
  if (input.text) {
    body.text = input.text;
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      let id: string | undefined;
      try {
        const data = (await res.json()) as { id?: string };
        if (typeof data.id === "string") id = data.id;
      } catch {
        // ignore — a 2xx without a parseable id still counts as sent
      }
      return id ? { ok: true, id } : { ok: true };
    }

    // Log status only — never the response body (may echo sensitive content).
    console.error(`[email] send failed to ${input.to} (subject: "${input.subject}") — status ${res.status}`);
    return { ok: false };
  } catch (err) {
    // Network/DNS errors — no body exists; log only recipient + subject.
    console.error(`[email] send error to ${input.to} (subject: "${input.subject}"): ${err instanceof Error ? err.message : "unknown error"}`);
    return { ok: false };
  }
}
