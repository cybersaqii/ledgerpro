import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import type { BillingStatus, DeviceSession } from "@/lib/sync-auth";
import type { Permission } from "@/lib/permissions";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

let dir = "";
let client: Client | null = null;
let syncAuth: typeof import("@/lib/sync-auth");

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

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-sync-auth-"));
  const url = "file:" + join(dir, "test.db");
  client = createClient({ url });
  await applyMigrations(client);
  // lib/db.ts reads DATABASE_URL at module load — set it before the import.
  process.env.DATABASE_URL = url;
  syncAuth = await import("@/lib/sync-auth");
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

function billing(level: BillingStatus["level"]): BillingStatus {
  return {
    level,
    trialDaysLeft: level === "TRIAL" ? 12 : 0,
    proDaysLeft: 0,
    trialEndsAt: null,
    proExpiresAt: null,
    plan: level === "PRO" ? "PRO" : "FREE",
  };
}

function session(isOwner: boolean, grants: Permission[]): DeviceSession {
  return {
    deviceId: "d1",
    userId: "u1",
    companyId: "c1",
    userName: "Test",
    role: isOwner ? "OWNER" : "STAFF",
    isOwner,
    grants,
    billing: billing("TRIAL"),
  };
}

describe("mintDeviceToken / hashDeviceToken", () => {
  it("mints a dvt_-prefixed token whose hash is a stable 64-char hex", () => {
    const { token, hash } = syncAuth.mintDeviceToken();
    expect(token.startsWith("dvt_")).toBe(true);
    expect(token.length).toBeGreaterThan(10);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(syncAuth.hashDeviceToken(token)).toBe(hash);
  });

  it("mints unique tokens", () => {
    const a = syncAuth.mintDeviceToken().token;
    const b = syncAuth.mintDeviceToken().token;
    expect(a).not.toBe(b);
    expect(syncAuth.hashDeviceToken(a)).not.toBe(syncAuth.hashDeviceToken(b));
  });
});

describe("syncProGate", () => {
  it("rejects FREE with 403 UPGRADE_REQUIRED and feature 'sync'", async () => {
    const res = syncAuth.syncProGate(billing("FREE"));
    expect(res).not.toBeNull();
    expect(res!.status).toBe(403);
    const body = await res!.json();
    expect(body.code).toBe("UPGRADE_REQUIRED");
    expect(body.feature).toBe("sync");
  });

  it("allows TRIAL and PRO through", () => {
    expect(syncAuth.syncProGate(billing("TRIAL"))).toBeNull();
    expect(syncAuth.syncProGate(billing("PRO"))).toBeNull();
  });
});

describe("deviceCan", () => {
  it("lets owners bypass grants", () => {
    expect(syncAuth.deviceCan(session(true, []), "sales")).toBe(true);
    expect(syncAuth.deviceCan(session(true, []), "pos")).toBe(true);
  });

  it("limits staff to their live grant set", () => {
    const ds = session(false, ["parties"]);
    expect(syncAuth.deviceCan(ds, "parties")).toBe(true);
    expect(syncAuth.deviceCan(ds, "sales")).toBe(false);
    expect(syncAuth.deviceCan(ds, "pos")).toBe(false);
  });
});
