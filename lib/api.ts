import { NextResponse } from "next/server";
import { getSession, type Session } from "./auth";

function serialize(data: unknown): string {
  return JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

export function json(data: unknown, init?: ResponseInit): NextResponse {
  return new NextResponse(serialize(data), {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers || {}) },
  });
}

/**
 * Error response. The optional stable `code` (e.g. "PERIOD_LOCKED",
 * "INSUFFICIENT_STOCK") lets the client show a localized message
 * (see lib/api-errors.ts); the human-readable `error` text stays as the
 * English fallback for codes the client doesn't know.
 */
export function err(message: string, status = 400, code?: string): NextResponse {
  return json({ error: message, ...(code ? { code } : {}) }, { status });
}

export async function requireAuth(): Promise<{ session: Session; response: null } | { session: null; response: NextResponse }> {
  const session = await getSession();
  if (!session) return { session: null, response: err("Please log in.", 401) };
  return { session, response: null };
}
