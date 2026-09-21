import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq, and } from "drizzle-orm";
import bcrypt from "bcryptjs";
import * as s from "@/db/schema";
import { NextRequest } from "next/server";
import { setupCompany } from "@/lib/setup";
import type { computeTotals as computeTotalsFn } from "@/lib/totals";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

let dir = "";
let client: Client | null = null;
let db: LibSQLDatabase<typeof s>;
let POST_push: (req: NextRequest) => Promise<Response>;
let POST_enroll: (req: NextRequest) => Promise<Response>;
let mintDeviceToken: () => { token: string; hash: string };
let parseMoney: (v: string) => bigint;
let parseQty: (v: string) => bigint;
let computeTotals: typeof computeTotalsFn;

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
const staffId = crypto.randomUUID();
const customerId = crypto.randomUUID();
const productId = crypto.randomUUID();
const PASSWORD = "push-test-99";
let ownerToken = "";
let staffToken = "";
let freeToken = "";

async function enroll(email: string, deviceName: string) {
  const req = new NextRequest("http://t/api/sync/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, deviceName, deviceModel: "Test" }),
  });
  const res = await POST_enroll(req);
  const body = await res.json();
  expect(res.status).toBe(200);
  return body as { deviceToken: string; deviceId: string; userId: string; companyId: string };
}

async function push(token: string, operations: unknown[]) {
  const req = new NextRequest("http://t/api/sync/push", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ deviceId: "test-device", clientTime: Date.now(), operations }),
  });
  const res = await POST_push(req);
  return { status: res.status, body: await res.json() };
}

const mkOp = (kind: string, refId: string, payload: unknown, extra: Record<string, unknown> = {}) => ({
  opId: crypto.randomUUID(),
  kind,
  refId,
  baseUpdatedAt: 0,
  clientUpdatedAt: Date.now(),
  payload,
  ...extra,
});

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-sync-push-"));
  const url = "file:" + join(dir, "test.db");
  client = createClient({ url });
  await applyMigrations(client);
  db = drizzle(client, { schema: s });
  // lib/db.ts reads DATABASE_URL at module load — set it before the dynamic imports.
  process.env.DATABASE_URL = url;

  POST_push = (await import("@/app/api/sync/push/route")).POST;
  POST_enroll = (await import("@/app/api/sync/enroll/route")).POST;
  mintDeviceToken = (await import("@/lib/sync-auth")).mintDeviceToken;
  parseMoney = (await import("@/lib/money")).parseMoney;
  parseQty = (await import("@/lib/qty")).parseQty;
  computeTotals = (await import("@/lib/totals")).computeTotals;

  // Trial company (sync allowed) + owner.
  await db.insert(s.companies).values({
    id: companyId,
    name: "Sync Push Co",
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await setupCompany(db, companyId);
  await db.insert(s.users).values({
    id: ownerId,
    companyId,
    name: "Owner",
    email: "owner@pushtest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "OWNER",
  });

  // Staff user with only the "parties" grant.
  await db.insert(s.users).values({
    id: staffId,
    companyId,
    name: "Staff",
    email: "staff@pushtest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "STAFF",
  });
  await db.insert(s.userPermissions).values({
    userId: staffId,
    companyId,
    permission: "parties",
    grantedAt: new Date(),
  });

  // Fixtures the doc ops need: a customer and a non-stock-tracked product.
  await db.insert(s.parties).values({
    id: customerId,
    companyId,
    kind: "CUSTOMER",
    name: "Push Customer",
    creditLimit: 0n,
  });
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "SYNC-ITEM",
    name: "Sync Item",
    unit: "PCS",
    purchasePrice: parseMoney("200"),
    salePrice: parseMoney("250"),
    trackStock: false,
    minSalePrice: 0n,
  });

  // FREE company + a pre-seeded device token (enroll itself is PRO-gated).
  const freeId = crypto.randomUUID();
  await db.insert(s.companies).values({
    id: freeId,
    name: "Free Push Co",
    trialEndsAt: new Date(Date.now() - 86_400_000),
    plan: "FREE",
  });
  const freeUserId = crypto.randomUUID();
  await db.insert(s.users).values({
    id: freeUserId,
    companyId: freeId,
    name: "Free Owner",
    email: "freeowner@pushtest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "OWNER",
  });
  const minted = mintDeviceToken();
  freeToken = minted.token;
  await db.insert(s.deviceTokens).values({
    id: crypto.randomUUID(),
    userId: freeUserId,
    companyId: freeId,
    deviceName: "Free Device",
    tokenHash: minted.hash,
    tokenVersion: 0,
  });

  ownerToken = (await enroll("owner@pushtest.pk", "Owner Tablet")).deviceToken;
  staffToken = (await enroll("staff@pushtest.pk", "Staff Phone")).deviceToken;
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("POST /api/sync/push", () => {
  it("accepts party.upsert and stores the client refId as the row id", async () => {
    const refId = crypto.randomUUID();
    const { status, body } = await push(ownerToken, [
      mkOp("party.upsert", refId, {
        kind: "CUSTOMER",
        name: "Sync Customer",
        phone: "03001234567",
        creditLimit: "0",
      }),
    ]);
    expect(status).toBe(200);
    expect(body.results).toHaveLength(1);
    expect(body.results[0].status).toBe("accepted");
    expect(body.results[0].refId).toBe(refId);

    const rows = await db.select().from(s.parties).where(eq(s.parties.id, refId));
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Sync Customer");
    expect(rows[0].companyId).toBe(companyId);
  });

  it("replays an identical result for a retried opId without applying twice", async () => {
    const opId = crypto.randomUUID();
    const refId = crypto.randomUUID();
    const op = {
      opId,
      kind: "party.upsert",
      refId,
      baseUpdatedAt: 0,
      clientUpdatedAt: Date.now(),
      payload: { kind: "CUSTOMER", name: "Idempotent Customer", creditLimit: "0" },
    };
    const r1 = await push(ownerToken, [op]);
    const r2 = await push(ownerToken, [op]);
    expect(r1.body.results[0].status).toBe("accepted");
    expect(r2.body.results[0].status).toBe("accepted");
    expect(r2.body.results[0].replayed).toBe(true);

    const strip = (r: Record<string, unknown>) => {
      const c = { ...r };
      delete c.replayed;
      delete c.opId;
      return c;
    };
    expect(strip(r2.body.results[0])).toEqual(strip(r1.body.results[0]));

    const rows = await db.select().from(s.parties).where(eq(s.parties.id, refId));
    expect(rows).toHaveLength(1);
  });

  it("pos.checkout computes totals server-side and posts a journal entry", async () => {
    const refId = crypto.randomUUID();
    const { status, body } = await push(ownerToken, [
      mkOp("pos.checkout", refId, {
        partyId: customerId,
        date: "2026-09-21",
        items: [{ productId, description: "Sync Item", qty: "2", rate: "250" }],
        payments: [],
      }),
    ]);
    expect(status).toBe(200);
    const r = body.results[0];
    expect(r.status).toBe("accepted");
    expect(r.docNoReassigned).toBe(false);

    const expected = computeTotals(
      [
        {
          productId,
          description: "Sync Item",
          qtyMilli: parseQty("2"),
          ratePaisa: parseMoney("250"),
          discountPaisa: 0n,
          taxBps: 0,
        },
      ],
      0n
    );
    expect(r.serverRow.grandTotal).toBe(expected.grandTotal.toString());

    const docs = await db.select().from(s.salesDocs).where(eq(s.salesDocs.id, refId));
    expect(docs).toHaveLength(1);
    expect(docs[0].status).toBe("POSTED");

    const entries = await db
      .select()
      .from(s.journalEntries)
      .where(eq(s.journalEntries.sourceId, refId));
    expect(entries).toHaveLength(1);
    expect(entries[0].source).toBe("SALES");
  });

  it("reports a conflict when the server copy is newer, keeps it, and audits sync.conflict", async () => {
    const refId = crypto.randomUUID();
    await push(ownerToken, [
      mkOp("party.upsert", refId, { kind: "CUSTOMER", name: "Conflict Customer", creditLimit: "0" }),
    ]);

    // "Web" edit bumps updated_at after the device's snapshot.
    await db
      .update(s.parties)
      .set({ name: "Web Edit", updatedAt: new Date() })
      .where(eq(s.parties.id, refId));

    // Stale device write (baseUpdatedAt=0, clientUpdatedAt=0 → server wins).
    const { status, body } = await push(ownerToken, [
      mkOp("party.upsert", refId, { kind: "CUSTOMER", name: "Device Edit", creditLimit: "0" }, { clientUpdatedAt: 0 }),
    ]);
    expect(status).toBe(200);
    const r = body.results[0];
    expect(r.status).toBe("conflict");
    expect(r.winner).toBe("server");
    expect(r.serverRow.name).toBe("Web Edit");
    expect(r.reason).toBeTruthy();

    // The stale write did not touch the server row.
    const rows = await db.select().from(s.parties).where(eq(s.parties.id, refId));
    expect(rows[0].name).toBe("Web Edit");

    const audits = await db
      .select()
      .from(s.auditLogs)
      .where(and(eq(s.auditLogs.action, "sync.conflict"), eq(s.auditLogs.entityId, refId)));
    expect(audits.length).toBeGreaterThan(0);
  });

  it("rejects sales.create for staff without the grant (FORBIDDEN_PERMISSION) but still answers HTTP 200", async () => {
    const refId = crypto.randomUUID();
    const { status, body } = await push(staffToken, [mkOp("sales.create", refId, {})]);
    expect(status).toBe(200);
    const r = body.results[0];
    expect(r.status).toBe("rejected");
    expect(r.error.code).toBe("FORBIDDEN_PERMISSION");
  });

  it("lets the same staff device push party.upsert (grant present)", async () => {
    const refId = crypto.randomUUID();
    const { status, body } = await push(staffToken, [
      mkOp("party.upsert", refId, { kind: "CUSTOMER", name: "Staff-Created Customer", creditLimit: "0" }),
    ]);
    expect(status).toBe(200);
    expect(body.results[0].status).toBe("accepted");
  });

  it("gates push for a FREE company with 403 UPGRADE_REQUIRED", async () => {
    const { status, body } = await push(freeToken, [
      mkOp("party.upsert", crypto.randomUUID(), { kind: "CUSTOMER", name: "Free Customer", creditLimit: "0" }),
    ]);
    expect(status).toBe(403);
    expect(body.code).toBe("UPGRADE_REQUIRED");
  });

  it("returns 401 for a revoked device token", async () => {
    const dev = await enroll("owner@pushtest.pk", "Revoke Tablet");
    await db
      .update(s.deviceTokens)
      .set({ revokedAt: new Date() })
      .where(eq(s.deviceTokens.id, dev.deviceId));

    const { status } = await push(dev.deviceToken, [
      mkOp("party.upsert", crypto.randomUUID(), { kind: "CUSTOMER", name: "Revoked Customer", creditLimit: "0" }),
    ]);
    expect(status).toBe(401);
  });

  it("always answers HTTP 200 for per-op rejections", async () => {
    const { status, body } = await push(ownerToken, [
      mkOp("party.upsert", crypto.randomUUID(), { kind: "CUSTOMER", name: "x" }), // name too short
    ]);
    expect(status).toBe(200);
    expect(body.results[0].status).toBe("rejected");
    expect(body.results[0].error.code).toBe("VALIDATION_ERROR");
  });
});
