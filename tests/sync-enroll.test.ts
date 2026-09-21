import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as s from "@/db/schema";
import { NextRequest } from "next/server";
import { setupCompany } from "@/lib/setup";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

let dir = "";
let client: Client | null = null;
let db: LibSQLDatabase<typeof s>;
let POST: (req: NextRequest) => Promise<Response>;
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
const ownerId = crypto.randomUUID();
const PASSWORD = "correct-horse-99";

async function enroll(email: string, password: string) {
  const req = new NextRequest("http://t/api/sync/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password, deviceName: "Test Tablet", deviceModel: "Test Model" }),
  });
  const res = await POST(req);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-sync-enroll-"));
  const url = "file:" + join(dir, "test.db");
  client = createClient({ url });
  await applyMigrations(client);
  db = drizzle(client, { schema: s });
  // lib/db.ts reads DATABASE_URL at module load — set it before the dynamic imports.
  process.env.DATABASE_URL = url;

  const enrollMod = await import("@/app/api/sync/enroll/route");
  POST = enrollMod.POST;
  hashDeviceToken = (await import("@/lib/sync-auth")).hashDeviceToken;

  // Trial company (sync allowed).
  await db.insert(s.companies).values({
    id: companyId,
    name: "Sync Trial Co",
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await setupCompany(db, companyId);
  await db.insert(s.users).values({
    id: ownerId,
    companyId,
    name: "Owner",
    email: "owner@synctest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "OWNER",
  });
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/sync/enroll", () => {
  it("rejects a wrong password with 401", async () => {
    const { status } = await enroll("owner@synctest.pk", "wrong-pass");
    expect(status).toBe(401);
  });

  it("rejects an unknown email with 401", async () => {
    const { status } = await enroll("nobody@synctest.pk", PASSWORD);
    expect(status).toBe(401);
  });

  it("enrolls with correct credentials and stores only the token hash", async () => {
    const { status, body } = await enroll("owner@synctest.pk", PASSWORD);
    expect(status).toBe(200);
    expect(body.deviceToken.startsWith("dvt_")).toBe(true);
    expect(body.deviceId).toBeTruthy();
    expect(body.userId).toBe(ownerId);
    expect(body.companyId).toBe(companyId);
    expect(typeof body.serverTime).toBe("number");

    const rows = await db.select().from(s.deviceTokens).where(eq(s.deviceTokens.id, body.deviceId));
    expect(rows).toHaveLength(1);
    expect(rows[0].userId).toBe(ownerId);
    // Only the sha256 is stored — never the raw token.
    expect(rows[0].tokenHash).toBe(hashDeviceToken(body.deviceToken));
    expect(rows[0].tokenHash).not.toBe(body.deviceToken);
    expect(rows[0].revokedAt).toBeNull();
  });

  it("blocks enrollment for a FREE (post-trial) company with 403 UPGRADE_REQUIRED", async () => {
    const freeId = crypto.randomUUID();
    await db.insert(s.companies).values({
      id: freeId,
      name: "Free Co",
      trialEndsAt: new Date(Date.now() - 86_400_000),
      plan: "FREE",
    });
    await setupCompany(db, freeId);
    await db.insert(s.users).values({
      id: crypto.randomUUID(),
      companyId: freeId,
      name: "Free Owner",
      email: "free@synctest.pk",
      passwordHash: bcrypt.hashSync(PASSWORD, 4),
      role: "OWNER",
    });

    const { status, body } = await enroll("free@synctest.pk", PASSWORD);
    expect(status).toBe(403);
    expect(body.code).toBe("UPGRADE_REQUIRED");
  });

  it("enrolls for a trial company (200)", async () => {
    const { status, body } = await enroll("owner@synctest.pk", PASSWORD);
    expect(status).toBe(200);
    expect(body.deviceToken.startsWith("dvt_")).toBe(true);
  });
});
