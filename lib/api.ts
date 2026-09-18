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

export function err(message: string, status = 400): NextResponse {
  return json({ error: message }, { status });
}

export async function requireAuth(): Promise<{ session: Session; response: null } | { session: null; response: NextResponse }> {
  const session = await getSession();
  if (!session) return { session: null, response: err("Please log in.", 401) };
  return { session, response: null };
}

const ROLE_RANK: Record<string, number> = {
  VIEWER: 1,
  CASHIER: 2,
  ACCOUNTANT: 3,
  ADMIN: 4,
  OWNER: 5,
};

export function hasRole(session: Session, minRole: keyof typeof ROLE_RANK): boolean {
  return (ROLE_RANK[session.role] || 0) >= ROLE_RANK[minRole];
}

export async function requireRole(minRole: keyof typeof ROLE_RANK) {
  const { session, response } = await requireAuth();
  if (!session) return { session: null, response };
  if (!hasRole(session, minRole)) return { session: null, response: err("You don't have permission for this action.", 403) };
  return { session, response: null };
}
