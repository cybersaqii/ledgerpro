/**
 * Module 25 — IP allowlisting (enterprise security).
 *
 * Per-company allowlist of IPs/CIDRs, enforced in requireCompany()
 * (lib/route-helpers.ts) so EVERY authenticated API route is covered with a
 * clear 403 + audit entry when a request is blocked.
 *
 * Design decisions (documented, deliberate):
 *  - OFF by default: when a company has zero allowlist rows the check is a
 *    no-op and every request is allowed (fail-open when unconfigured).
 *  - Owners always bypass: an owner can never be locked out of their own
 *    company by a bad rule. Named staff bypasses live in ip_bypass_users.
 *  - IPv4 supports CIDR ranges (10.0.0.0/8) and single addresses; IPv6
 *    supports exact-address match only (documented limitation).
 *  - When the allowlist IS configured and the client IP cannot be
 *    determined ("unknown"), the request is blocked (fail-closed) — an
 *    undeterminable IP must not silently pass a configured policy.
 */
import { and, eq } from "drizzle-orm";
import { ipAllowlist, ipBypassUsers, users } from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";

export interface IpCheckResult {
  allowed: boolean;
  /** "disabled" | "owner-bypass" | "user-bypass" | "allowlisted" | "not-allowlisted" | "unknown-ip" */
  reason: string;
}

/** Parse a dotted-quad IPv4 address to a 32-bit bigint. Null when invalid. */
export function parseIPv4(ip: string): bigint | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = (n << 8n) | BigInt(v);
  }
  return n;
}

/**
 * Does `ip` fall inside `cidr`? cidr is "a.b.c.d" (exact) or "a.b.c.d/n".
 * IPv6 (contains ':') only supports exact match. Pure function — tested.
 */
export function cidrContains(cidr: string, ip: string): boolean {
  const c = cidr.trim();
  const addr = ip.trim();
  if (!c || !addr) return false;
  // IPv6: exact match only.
  if (c.includes(":") || addr.includes(":")) {
    return c.toLowerCase() === addr.toLowerCase() && !c.includes("/");
  }
  const slash = c.indexOf("/");
  const base = slash === -1 ? c : c.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(c.slice(slash + 1));
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const baseN = parseIPv4(base);
  const ipN = parseIPv4(addr);
  if (baseN === null || ipN === null) return false;
  if (bits === 0) return true;
  const mask = ((1n << BigInt(bits)) - 1n) << (32n - BigInt(bits));
  return (baseN & mask) === (ipN & mask);
}

/** Validate + canonicalize a user-supplied CIDR/address. Throws UserError(422). */
export function normalizeCidr(input: string): string {
  const c = input.trim();
  if (!c) throw new UserError("IP address is required.", 422, "INVALID_IP");
  if (c.includes(":")) {
    // IPv6: exact address only, no prefix.
    if (c.includes("/") || !/^[0-9a-fA-F:]{2,45}$/.test(c))
      throw new UserError("IPv6 allowlist entries must be exact addresses (no CIDR).", 422, "INVALID_IP");
    return c.toLowerCase();
  }
  const slash = c.indexOf("/");
  const base = slash === -1 ? c : c.slice(0, slash);
  const bits = slash === -1 ? 32 : Number(c.slice(slash + 1));
  if (parseIPv4(base) === null || !Number.isInteger(bits) || bits < 0 || bits > 32)
    throw new UserError("Enter a valid IPv4 address or CIDR (e.g. 203.0.113.7 or 203.0.113.0/24).", 422, "INVALID_IP");
  return `${base}/${bits}`;
}

/**
 * The enforcement check. `role` must be the LIVE role re-read from the DB
 * (never the session's cached copy).
 */
export async function checkIpAllowed(
  dbc: Db | DbTx,
  opts: { companyId: string; userId: string; role: string; ip: string }
): Promise<IpCheckResult> {
  const rows = await dbc
    .select({ cidr: ipAllowlist.cidr })
    .from(ipAllowlist)
    .where(eq(ipAllowlist.companyId, opts.companyId));
  // Fail-open when unconfigured: the feature is OFF until the first rule exists.
  if (rows.length === 0) return { allowed: true, reason: "disabled" };
  // Owners always bypass — an owner can never lock themselves out.
  if (opts.role === "OWNER") return { allowed: true, reason: "owner-bypass" };
  const bypass = await dbc
    .select({ userId: ipBypassUsers.userId })
    .from(ipBypassUsers)
    .where(and(eq(ipBypassUsers.companyId, opts.companyId), eq(ipBypassUsers.userId, opts.userId)))
    .limit(1);
  if (bypass[0]) return { allowed: true, reason: "user-bypass" };
  const ip = (opts.ip || "").trim();
  if (!ip || ip === "unknown") return { allowed: false, reason: "unknown-ip" };
  for (const r of rows) {
    if (cidrContains(r.cidr, ip)) return { allowed: true, reason: "allowlisted" };
  }
  return { allowed: false, reason: "not-allowlisted" };
}

export async function listAllowlist(dbc: Db | DbTx, companyId: string) {
  return dbc
    .select()
    .from(ipAllowlist)
    .where(eq(ipAllowlist.companyId, companyId))
    .orderBy(ipAllowlist.createdAt);
}

export async function addAllowlistEntry(
  tx: DbTx,
  companyId: string,
  cidr: string,
  label: string | null,
  createdById: string
): Promise<string> {
  const id = crypto.randomUUID();
  await tx.insert(ipAllowlist).values({
    id,
    companyId,
    cidr: normalizeCidr(cidr),
    label: label?.trim() || null,
    createdById,
  });
  return id;
}

export async function removeAllowlistEntry(tx: DbTx, companyId: string, entryId: string): Promise<void> {
  await tx
    .delete(ipAllowlist)
    .where(and(eq(ipAllowlist.id, entryId), eq(ipAllowlist.companyId, companyId)));
}

export async function listBypassUsers(dbc: Db | DbTx, companyId: string) {
  return dbc
    .select({ userId: ipBypassUsers.userId, name: users.name, email: users.email, createdAt: ipBypassUsers.createdAt })
    .from(ipBypassUsers)
    .innerJoin(users, eq(ipBypassUsers.userId, users.id))
    .where(eq(ipBypassUsers.companyId, companyId));
}

export async function addBypassUser(
  tx: DbTx,
  companyId: string,
  userId: string,
  createdById: string
): Promise<void> {
  const u = await tx
    .select({ id: users.id, companyId: users.companyId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u[0] || u[0].companyId !== companyId)
    throw new UserError("User not found in this company.", 404, "NOT_FOUND");
  await tx
    .insert(ipBypassUsers)
    .values({ companyId, userId, createdById })
    .onConflictDoNothing();
}

export async function removeBypassUser(tx: DbTx, companyId: string, userId: string): Promise<void> {
  await tx
    .delete(ipBypassUsers)
    .where(and(eq(ipBypassUsers.companyId, companyId), eq(ipBypassUsers.userId, userId)));
}
