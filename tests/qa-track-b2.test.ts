/**
 * TRACK-B2 (backend / security / money-math) regression tests.
 *
 * B2-1 (CRITICAL, fixed): POST /api/auth/signup with an already-registered
 * email must NOT mint a session unless the OTP/Google step proved ownership
 * of that address (emailVerified). Before the fix, anyone who knew a victim's
 * email could POST a signup and receive a full OWNER session — no password,
 * no OTP. Deactivated users are also blocked from signing back in here.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import * as s from "@/db/schema";

// Cookie jar stand-in: createSession() in @/lib/auth calls cookies().set().
// next/headers only works inside a real Next request, so we fake the jar and
// record every set() — a recorded set means a session was minted.
const jarState = vi.hoisted(() => ({ sets: [] as string[] }));
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (_name: string) => undefined,
    set: (name: string) => {
      jarState.sets.push(name);
    },
    delete: (_name: string) => {},
  }),
}));

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

async function migrateFileDb(url: string): Promise<void> {
  const client = createClient({ url });
  try {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const text = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("--");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      for (const stmt of text.split(";").map((x) => x.trim()).filter((x) => x.length > 0)) {
        await client.execute(stmt);
      }
    }
  } finally {
    client.close();
  }
}

let POST: (req: NextRequest) => Promise<Response>;
let signEmailVerificationToken: (email: string) => Promise<string>;
let seed: LibSQLDatabase<typeof s>;
let seedClient: Client;

const ACTIVE_EMAIL = "owner-b2@ledgerpro.test";
const DEAD_EMAIL = "dead-b2@ledgerpro.test";
const companyId = crypto.randomUUID();

let ipCounter = 0;
async function signup(body: Record<string, unknown>) {
  jarState.sets.length = 0; // reset session-minting record
  ipCounter += 1;
  const req = new NextRequest("http://t/api/auth/signup", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `10.200.0.${ipCounter}`, // fresh IP per call — own rate-limit bucket
    },
    body: JSON.stringify(body),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json(), sessionMinted: jarState.sets.length > 0 };
}

const baseBody = (email: string) => ({
  companyName: "B2 Victim Co",
  name: "Attacker",
  email,
  password: "SomeStrongPass123!",
  businessType: "RETAIL",
});

beforeAll(async () => {
  await migrateFileDb(ROUTES_DB_URL);
  seedClient = createClient({ url: ROUTES_DB_URL });
  seed = drizzle(seedClient, { schema: s });

  // The route module (and @/lib/db) must load AFTER DATABASE_URL points at the
  // isolated file DB — qa-routes-env (imported first) guarantees that.
  POST = (await import("@/app/api/auth/signup/route")).POST;
  signEmailVerificationToken = (await import("@/lib/auth")).signEmailVerificationToken;

  await seed.insert(s.companies).values({
    id: companyId,
    name: "B2 Victim Co",
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await seed.insert(s.users).values({
    id: crypto.randomUUID(),
    companyId,
    name: "Real Owner",
    email: ACTIVE_EMAIL,
    passwordHash: "not-a-real-hash",
    role: "OWNER",
    isActive: true,
  });
  await seed.insert(s.users).values({
    id: crypto.randomUUID(),
    companyId,
    name: "Deactivated Staff",
    email: DEAD_EMAIL,
    passwordHash: "not-a-real-hash",
    role: "STAFF",
    isActive: false,
  });
}, 120_000);

afterAll(() => {
  seedClient?.close();
});

describe("B2-1 — signup with an already-registered email", () => {
  it("refuses a passwordless sign-in when ownership was NOT proved (409, no session)", async () => {
    const r = await signup(baseBody(ACTIVE_EMAIL));
    expect(r.status).toBe(409);
    expect(r.sessionMinted).toBe(false);
    // The victim's account is untouched — still exactly one row for the email.
    const rows = await seed.select({ id: s.users.id }).from(s.users).where(eq(s.users.email, ACTIVE_EMAIL));
    expect(rows).toHaveLength(1);
  });

  it("still signs in the existing user after a valid OTP verification token (200, session)", async () => {
    const token = await signEmailVerificationToken(ACTIVE_EMAIL);
    const r = await signup({ ...baseBody(ACTIVE_EMAIL), verificationToken: token });
    expect(r.status).toBe(200);
    expect(r.body?.data?.existing).toBe(true);
    expect(r.sessionMinted).toBe(true);
  });

  it("blocks a deactivated user even WITH a valid verification token (403, no session)", async () => {
    const token = await signEmailVerificationToken(DEAD_EMAIL);
    const r = await signup({ ...baseBody(DEAD_EMAIL), verificationToken: token });
    expect(r.status).toBe(403);
    expect(r.sessionMinted).toBe(false);
  });

  it("a forged/tampered verification token does not prove ownership (409, no session)", async () => {
    const r = await signup({ ...baseBody(ACTIVE_EMAIL), verificationToken: "forged.token.value" });
    expect(r.status).toBe(409);
    expect(r.sessionMinted).toBe(false);
  });

  it("a brand-new email still completes signup normally (sanity, no regression)", async () => {
    const email = "fresh-b2@ledgerpro.test";
    const token = await signEmailVerificationToken(email);
    const r = await signup({ ...baseBody(email), verificationToken: token });
    expect(r.status).toBe(200);
    expect(r.body?.ok).toBe(true);
    const rows = await seed
      .select({ emailVerifiedAt: s.users.emailVerifiedAt })
      .from(s.users)
      .where(eq(s.users.email, email));
    expect(rows).toHaveLength(1);
    expect(rows[0].emailVerifiedAt).not.toBeNull();
  });
});
