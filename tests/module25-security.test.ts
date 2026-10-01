/**
 * Module 25 — security (IP allowlist + login-attempt audit).
 *
 * Covers: CIDR matching (single IP, /24 ranges, /32, boundaries, IPv6
 * exact-match, invalid input); normalizeCidr (/32 default, trimming,
 * rejection of garbage); checkIpAllowed fail-open when unconfigured,
 * fail-closed when configured, owner bypass, user bypass list, and
 * blocked-attempt auditing; recordLoginAttempt / listLoginAttempts
 * (newest-first, limit respected).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import * as s from "@/db/schema";
import {
  cidrContains,
  normalizeCidr,
  checkIpAllowed,
  listAllowlist,
  addAllowlistEntry,
  removeAllowlistEntry,
  addBypassUser,
  removeBypassUser,
} from "@/lib/ip-allowlist";
import { recordLoginAttempt, listLoginAttempts } from "@/lib/security";

let db: TestDb;
let cleanup: () => void;
const companyId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const staffId = crypto.randomUUID();

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await db.insert(s.companies).values({ id: companyId, name: "M25 Test Co" });
  await setupCompany(db, companyId);
  await db.insert(s.users).values([
    { id: ownerId, companyId, name: "M25 Owner", email: "owner@m25.test", role: "OWNER", passwordHash: "x", isActive: true },
    { id: staffId, companyId, name: "M25 Staff", email: "staff@m25.test", role: "STAFF", passwordHash: "x", isActive: true },
  ]);
});

afterAll(() => cleanup());

// ─── CIDR matching ───────────────────────────────────────────────────

describe("25.1 cidrContains", () => {
  it("matches a single IP", () => {
    expect(cidrContains("203.0.113.7", "203.0.113.7")).toBe(true);
    expect(cidrContains("203.0.113.7", "203.0.113.8")).toBe(false);
  });
  it("matches a /24 range and its boundaries", () => {
    expect(cidrContains("192.168.1.0/24", "192.168.1.0")).toBe(true);
    expect(cidrContains("192.168.1.0/24", "192.168.1.255")).toBe(true);
    expect(cidrContains("192.168.1.0/24", "192.168.2.1")).toBe(false);
  });
  it("treats /32 as a single host", () => {
    expect(cidrContains("10.0.0.5/32", "10.0.0.5")).toBe(true);
    expect(cidrContains("10.0.0.5/32", "10.0.0.6")).toBe(false);
  });
  it("matches an IPv6 address exactly", () => {
    expect(cidrContains("::1", "::1")).toBe(true);
    expect(cidrContains("::1", "::2")).toBe(false);
  });
  it("returns false for garbage", () => {
    expect(cidrContains("not-an-ip", "1.2.3.4")).toBe(false);
    expect(cidrContains("1.2.3.4/24", "not-an-ip")).toBe(false);
    expect(cidrContains("1.2.3.4/99", "1.2.3.4")).toBe(false);
  });
});

describe("25.2 normalizeCidr", () => {
  it("adds /32 to a bare IPv4 address", () => {
    expect(normalizeCidr(" 10.0.0.5 ")).toBe("10.0.0.5/32");
  });
  it("keeps an explicit prefix", () => {
    expect(normalizeCidr("192.168.0.0/16")).toBe("192.168.0.0/16");
  });
  it("keeps IPv6 as-is", () => {
    expect(normalizeCidr("::1")).toBe("::1");
  });
  it("throws on invalid input", () => {
    expect(() => normalizeCidr("hello")).toThrow();
    expect(() => normalizeCidr("1.2.3.4/99")).toThrow();
    expect(() => normalizeCidr("")).toThrow();
  });
});

// ─── allowlist decisions ─────────────────────────────────────────────

describe("25.3 checkIpAllowed", () => {
  const staff = { companyId, userId: staffId, role: "STAFF" };
  const owner = { companyId, userId: ownerId, role: "OWNER" };

  it("is fail-open when nothing is configured", async () => {
    const r = await checkIpAllowed(db, { ...staff, ip: "198.51.100.9" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("disabled");
  });

  it("allows a matching IP and blocks a stranger (fail-closed)", async () => {
    const id = await db.transaction((tx) => addAllowlistEntry(tx, companyId, "203.0.113.0/24", "Office", ownerId));
    expect((await checkIpAllowed(db, { ...staff, ip: "203.0.113.44" })).allowed).toBe(true);
    expect((await checkIpAllowed(db, { ...staff, ip: "203.0.113.44" })).reason).toBe("allowlisted");
    const blocked = await checkIpAllowed(db, { ...staff, ip: "198.51.100.9" });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe("not-allowlisted");
    // Unknown IPs fail closed once the feature is configured.
    expect((await checkIpAllowed(db, { ...staff, ip: "unknown" })).allowed).toBe(false);
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, id));
  });

  it("owners always bypass the allowlist", async () => {
    const id = await db.transaction((tx) => addAllowlistEntry(tx, companyId, "203.0.113.0/24", "Office", ownerId));
    const r = await checkIpAllowed(db, { ...owner, ip: "198.51.100.9" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("owner-bypass");
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, id));
  });

  it("bypass-listed staff bypass the allowlist", async () => {
    const id = await db.transaction((tx) => addAllowlistEntry(tx, companyId, "203.0.113.0/24", "Office", ownerId));
    await db.transaction((tx) => addBypassUser(tx, companyId, staffId, ownerId));
    const r = await checkIpAllowed(db, { ...staff, ip: "198.51.100.9" });
    expect(r.allowed).toBe(true);
    expect(r.reason).toBe("user-bypass");
    await db.transaction((tx) => removeBypassUser(tx, companyId, staffId));
    expect((await checkIpAllowed(db, { ...staff, ip: "198.51.100.9" })).allowed).toBe(false);
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, id));
  });

  it("addAllowlistEntry normalizes bare IPs to /32", async () => {
    const id = await db.transaction((tx) => addAllowlistEntry(tx, companyId, " 10.9.9.9 ", "HQ", ownerId));
    const list = await listAllowlist(db, companyId);
    expect(list.find((e) => e.id === id)!.cidr).toBe("10.9.9.9/32");
    expect((await checkIpAllowed(db, { ...staff, ip: "10.9.9.9" })).allowed).toBe(true);
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, id));
  });

  it("listAllowlist returns entries in creation order", async () => {
    const a = await db.transaction((tx) => addAllowlistEntry(tx, companyId, "10.0.0.0/8", "A", ownerId));
    const b = await db.transaction((tx) => addAllowlistEntry(tx, companyId, "172.16.0.0/12", "B", ownerId));
    const list = await listAllowlist(db, companyId);
    expect(list.map((e) => e.cidr)).toEqual(["10.0.0.0/8", "172.16.0.0/12"]);
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, a));
    await db.transaction((tx) => removeAllowlistEntry(tx, companyId, b));
  });
});

// ─── login-attempt audit ─────────────────────────────────────────────

describe("25.4 login attempts", () => {
  it("records successes and failures, newest first, honoring the limit", async () => {
    await db.transaction((tx) =>
      recordLoginAttempt(tx, { companyId, email: "a@m25.test", ip: "1.1.1.1", userAgent: null, result: "FAIL", reason: "INVALID_CREDENTIALS" })
    );
    await db.transaction((tx) =>
      recordLoginAttempt(tx, { companyId, email: "a@m25.test", ip: "1.1.1.1", userAgent: null, result: "SUCCESS", reason: null })
    );
    const rows = await listLoginAttempts(db, companyId, 10);
    expect(rows[0]!.result).toBe("SUCCESS");
    expect(rows[1]!.result).toBe("FAIL");
    expect(rows[1]!.reason).toBe("INVALID_CREDENTIALS");
    const one = await listLoginAttempts(db, companyId, 1);
    expect(one).toHaveLength(1);
  });
});
