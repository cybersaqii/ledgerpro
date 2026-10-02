import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/edge-auth";

/**
 * GET /api/auth/expired
 *
 * Clears a stale session cookie and sends the browser to /login.
 *
 * Why this route exists: the edge proxy (proxy.ts) judges a session by the
 * JWT *signature* alone, while getSession() also enforces DB state
 * (tokenVersion, isActive, company match, idle timeout). A cookie can
 * therefore be cryptographically valid yet dead server-side — e.g. the idle
 * timeout expiring after the browser was closed. If the (app) layout sent
 * such a request straight to /login, the proxy would see the "valid" token
 * and bounce /login → /dashboard → /login forever (ERR_TOO_MANY_REDIRECTS).
 * Clearing the cookie here restores agreement so /login renders the form.
 * Cookie mutation is only allowed in Route Handlers / Server Actions, which
 * is why this lives here instead of in the layout.
 */
export async function GET(request: Request) {
  const res = NextResponse.redirect(new URL("/login", request.url));
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
