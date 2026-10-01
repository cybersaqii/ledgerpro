/**
 * Shared gate for the public /api/portal/[token] routes (Module 11).
 *
 * Every public portal request is:
 *   1. rate-limited — 60/min per client IP (DB-backed sliding window, shared
 *      across serverless instances; fails open on DB errors per convention);
 *   2. token-validated server-side via resolvePortalToken (sha256 hash lookup
 *      + constant-time compare + expiry/revocation checks);
 *   3. access-level checked against the token's VIEW_ONLY | ORDER | FULL grant.
 */
import type { NextRequest } from "next/server";
import { json, err } from "./api";
import { db } from "./route-helpers";
import type { Db } from "./db";
import { resolvePortalToken, portalCan, type PortalAccessLevel, type PortalContext } from "./portal";
import { rateLimitDb, clientIp } from "./rate-limit-db";

export const PORTAL_RATE_LIMIT = 60;
export const PORTAL_RATE_WINDOW_MS = 60_000;

export type PortalGate =
  | { ok: true; ctx: PortalContext }
  | { ok: false; response: ReturnType<typeof err> };

export async function portalGate(
  req: NextRequest,
  rawToken: string,
  needed?: PortalAccessLevel,
  dbx: Db = db
): Promise<PortalGate> {
  const rl = await rateLimitDb(`portal:${clientIp(req)}`, PORTAL_RATE_LIMIT, PORTAL_RATE_WINDOW_MS, dbx);
  if (!rl.ok) {
    return {
      ok: false,
      response: err("Too many requests. Please wait a moment and try again.", 429, "RATE_LIMITED"),
    };
  }
  const res = await resolvePortalToken(dbx, rawToken);
  if (!res.ok) {
    const status = res.code === "PORTAL_TOKEN_INVALID" ? 404 : 403;
    return { ok: false, response: err(res.message, status, res.code) };
  }
  if (needed && !portalCan(res.ctx.token.accessLevel, needed)) {
    return {
      ok: false,
      response: err("Your portal access level does not allow this action.", 403, "PORTAL_FORBIDDEN"),
    };
  }
  return { ok: true, ctx: res.ctx };
}

/** JSON-safe portal context for the client (no hashes, no internals). */
export function publicPortalContext(ctx: PortalContext) {
  return {
    companyName: ctx.company.tradeName || ctx.company.name,
    companyPhone: ctx.company.phone,
    companyEmail: ctx.company.email,
    partyName: ctx.party.name,
    partyKind: ctx.party.kind,
    accessLevel: ctx.token.accessLevel,
    expiresAt: ctx.token.expiresAt ? ctx.token.expiresAt.getTime() : null,
  };
}

export { json, err };
