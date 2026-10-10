// GET / POST-less /api/sync/devices (list) and DELETE /api/sync/devices/[id]
// (revoke) with dual auth: Bearer dvt_ device tokens AND cookie sessions.
// Auth decision: any `Authorization: Bearer <token>` header is a device-token
// attempt (requireDevice(); its 401s stand, no cookie fallback). No Bearer
// credential → requireCompany() cookie session, the pre-existing web behavior.
//
// Cookie sessions are exercised by stubbing next/headers' cookies() with a
// forged JWT signed by the same dev secret lib/auth.ts uses in tests.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";
import { SignJWT } from "jose";
import * as s from "@/db/schema";
import { NextRequest } from "next/server";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

// Mutable cookie jar behind the next/headers stub (vi.mock is hoisted, so the
// state lives in a vi.hoisted box). SESSION_COOKIE = "ledgerpro_session".
const cookieJar = vi.hoisted(() => ({ value: null as string | null }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ledgerpro_session" && cookieJar.value ? { value: cookieJar.value } : undefined,
    set: () => {},
    delete: () => {},
  }),
}));

let dir = "";
let client: Client | null = null;
let db: LibSQLDatabase<typeof s>;
let GET: (req: NextRequest) => Promise<Response>;
let DELETE: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
let mintDeviceToken: () => { token: string; hash: string };
let hashDeviceToken: (t: string) => string;

async function applyMigrations(c: Client) {
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    for (const stmt of text.split(";").map((x) => x.trim()).filter(Boolean)) {
      await c.execute(stmt);
    }
  }
}

const companyId = crypto.randomUUID();
const otherCompanyId = crypto.randomUUID();
const ownerId = crypto.randomUUID();
const staff1Id = crypto.randomUUID();
const staff2Id = crypto.randomUUID();
const otherOwnerId = crypto.randomUUID();

// Raw device tokens (kept in test memory; only hashes hit the DB).
const raw: Record<string, string> = {};
const deviceIds: Record<string, string> = {};

function bearerReq(token: string, id?: string) {
  const url = id ? `http://t/api/sync/devices/${id}` : "http://t/api/sync/devices";
  return new NextRequest(url, {
    method: id ? "DELETE" : "GET",
    headers: { authorization: `Bearer ${token}` },
  });
}
const cookieReq = (id?: string) =>
  new NextRequest(id ? `http://t/api/sync/devices/${id}` : "http://t/api/sync/devices", {
    method: id ? "DELETE" : "GET",
  });
const delCtx = (id: string) => ({ params: Promise.resolve({ id }) });

/** Forge a cookie-session JWT the way lib/auth.createSession does in tests. */
async function forgeSession(uid: string, name: string, role: string): Promise<string> {
  const secret = new TextEncoder().encode(
    process.env.AUTH_SECRET || "dev-only-secret-change-me-32-chars-min"
  );
  return new SignJWT({ uid, cid: companyId, name, email: `${uid}@x.pk`, role, v: 0 })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

async function seedDevice(key: string, userId: string, cid: string, name: string) {
  const { token, hash } = mintDeviceToken();
  raw[key] = token;
  const id = crypto.randomUUID();
  deviceIds[key] = id;
  await db.insert(s.deviceTokens).values({
    id,
    userId,
    companyId: cid,
    deviceName: name,
    deviceModel: "Test Model",
    tokenHash: hash,
    tokenVersion: 0,
  });
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-sync-devices-"));
  const url = "file:" + join(dir, "test.db");
  client = createClient({ url });
  await applyMigrations(client);
  db = drizzle(client, { schema: s });
  // lib/db.ts reads DATABASE_URL at module load — set it before the dynamic imports.
  process.env.DATABASE_URL = url;

  const listMod = await import("@/app/api/sync/devices/route");
  const revokeMod = await import("@/app/api/sync/devices/[id]/route");
  GET = listMod.GET;
  DELETE = revokeMod.DELETE;
  const sa = await import("@/lib/sync-auth");
  mintDeviceToken = sa.mintDeviceToken;
  hashDeviceToken = sa.hashDeviceToken;

  // Trial companies (sync allowed on both).
  const trialAt = new Date(Date.now() + 30 * 86_400_000);
  await db.insert(s.companies).values({ id: companyId, name: "Devices Co", trialEndsAt: trialAt });
  await db.insert(s.companies).values({ id: otherCompanyId, name: "Other Co", trialEndsAt: trialAt });

  const user = async (id: string, cid: string, name: string, role: "OWNER" | "STAFF") => {
    await db.insert(s.users).values({ id, companyId: cid, name, email: `${id}@x.pk`, passwordHash: "x", role });
    // Migration 0057: session validation requires a user_companies row.
    await db.insert(s.userCompanies).values({ id: `uc-${id}`, userId: id, companyId: cid, role, isActive: true });
  };
  await user(ownerId, companyId, "Owner", "OWNER");
  await user(staff1Id, companyId, "Staff One", "STAFF");
  await user(staff2Id, companyId, "Staff Two", "STAFF");
  await user(otherOwnerId, otherCompanyId, "Other Owner", "OWNER");

  await seedDevice("owner", ownerId, companyId, "Owner Phone");
  await seedDevice("s1a", staff1Id, companyId, "Staff1 Tablet A");
  await seedDevice("s1b", staff1Id, companyId, "Staff1 Tablet B");
  await seedDevice("s2", staff2Id, companyId, "Staff2 Phone");
  await seedDevice("other", otherOwnerId, otherCompanyId, "Other Co Phone");
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  cookieJar.value = null; // each cookie test sets its own jar
});

describe("GET /api/sync/devices with device-token Bearer auth", () => {
  it("staff device Bearer lists only its user's devices", async () => {
    const res = await GET(bearerReq(raw.s1a));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    for (const d of body.devices) expect(d.userId).toBe(staff1Id);
    const ids = body.devices.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([deviceIds.s1a, deviceIds.s1b].sort());
    // Token hashes are never exposed.
    for (const d of body.devices) {
      expect(JSON.stringify(d)).not.toContain(hashDeviceToken(raw.s1a));
    }
  });

  it("owner device Bearer lists all company devices (and none from other companies)", async () => {
    const res = await GET(bearerReq(raw.owner));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.devices.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([deviceIds.owner, deviceIds.s1a, deviceIds.s1b, deviceIds.s2].sort());
    expect(ids).not.toContain(deviceIds.other);
  });

  it("invalid Bearer → 401 DEVICE_AUTH_INVALID, even with a valid session cookie present (no fallback)", async () => {
    cookieJar.value = await forgeSession(ownerId, "Owner", "OWNER");
    const res = await GET(bearerReq("dvt_" + "0".repeat(40)));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.code).toBe("DEVICE_AUTH_INVALID");
  });

  it("revoked Bearer → 401 and never falls back to the cookie session", async () => {
    cookieJar.value = await forgeSession(ownerId, "Owner", "OWNER");
    // Revoke the other-company device row directly, then present its token.
    const res = await GET(bearerReq(raw.other));
    expect(res.status).toBe(200); // sanity: other company's owner token works
    await db
      .update(s.deviceTokens)
      .set({ revokedAt: new Date() })
      .where(eq(s.deviceTokens.id, deviceIds.other));
    const res2 = await GET(bearerReq(raw.other));
    expect(res2.status).toBe(401);
    expect((await res2.json()).code).toBe("DEVICE_AUTH_INVALID");
  });
});

describe("GET /api/sync/devices with cookie-session auth (existing behavior)", () => {
  it("no Authorization header → valid cookie session still works (owner sees all)", async () => {
    cookieJar.value = await forgeSession(ownerId, "Owner", "OWNER");
    const res = await GET(cookieReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.devices.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([deviceIds.owner, deviceIds.s1a, deviceIds.s1b, deviceIds.s2].sort());
  });

  it("no Authorization header → valid cookie session still works (staff sees own only)", async () => {
    cookieJar.value = await forgeSession(staff1Id, "Staff One", "STAFF");
    const res = await GET(cookieReq());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.devices).toHaveLength(2);
    for (const d of body.devices) expect(d.userId).toBe(staff1Id);
  });

  it("no Authorization header and no cookie → 401 via the cookie path (not the device-token error)", async () => {
    const res = await GET(cookieReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Please log in."); // requireCompany's 401…
    expect(body.code).not.toBe("DEVICE_AUTH_REQUIRED"); // …not requireDevice's
  });
});

describe("DELETE /api/sync/devices/[id] with device-token Bearer auth", () => {
  it("staff device cannot revoke another user's device (403)", async () => {
    const res = await DELETE(bearerReq(raw.s1a, deviceIds.owner), delCtx(deviceIds.owner));
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe("You can only revoke your own devices.");
    const [row] = await db
      .select()
      .from(s.deviceTokens)
      .where(eq(s.deviceTokens.id, deviceIds.owner));
    expect(row.revokedAt).toBeNull();
  });

  it("device self-revoke succeeds, writes the sync.revoke audit row, and the token dies", async () => {
    const res = await DELETE(bearerReq(raw.s2, deviceIds.s2), delCtx(deviceIds.s2));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(s.deviceTokens)
      .where(eq(s.deviceTokens.id, deviceIds.s2));
    expect(row.revokedAt).not.toBeNull();

    const audits = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.action, "sync.revoke"), eq(s.auditLogs.entityId, deviceIds.s2)));
    expect(audits).toHaveLength(1);
    expect(audits[0].userId).toBe(staff2Id);
    expect(audits[0].userName).toBe("Staff Two");
    expect(audits[0].companyId).toBe(companyId);
    expect(audits[0].detail).toBe("Staff2 Phone");

    // The token is dead now — the "logged out" device can no longer call sync endpoints.
    const res2 = await GET(bearerReq(raw.s2));
    expect(res2.status).toBe(401);
    expect((await res2.json()).code).toBe("DEVICE_AUTH_INVALID");
  });

  it("owner device can revoke any company device; revoke is idempotent", async () => {
    const res = await DELETE(bearerReq(raw.owner, deviceIds.s1b), delCtx(deviceIds.s1b));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const again = await DELETE(bearerReq(raw.owner, deviceIds.s1b), delCtx(deviceIds.s1b));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true });
  });

  it("cannot revoke a device from another company (404)", async () => {
    const otherId = crypto.randomUUID();
    await db.insert(s.deviceTokens).values({
      id: otherId,
      userId: otherOwnerId,
      companyId: otherCompanyId,
      deviceName: "Sneaky",
      deviceModel: "x",
      tokenHash: hashDeviceToken(mintDeviceToken().token),
      tokenVersion: 0,
    });
    const res = await DELETE(bearerReq(raw.owner, otherId), delCtx(otherId));
    expect(res.status).toBe(404);
  });
});
