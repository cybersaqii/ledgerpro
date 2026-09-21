import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import bcrypt from "bcryptjs";
import * as s from "@/db/schema";
import { NextRequest } from "next/server";
import { setupCompany } from "@/lib/setup";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

let dir = "";
let client: Client | null = null;
let db: LibSQLDatabase<typeof s>;
let GET: (req: NextRequest) => Promise<Response>;
let POST_enroll: (req: NextRequest) => Promise<Response>;

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
const partyId = crypto.randomUUID();
const productId = crypto.randomUUID();
const PASSWORD = "pull-test-99";
let ownerToken = "";
let staffToken = "";

async function enroll(email: string, deviceName: string) {
  const req = new NextRequest("http://t/api/sync/enroll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD, deviceName, deviceModel: "Test" }),
  });
  const res = await POST_enroll(req);
  const body = await res.json();
  expect(res.status).toBe(200);
  return body.deviceToken as string;
}

async function pull(token: string, query: string) {
  const req = new NextRequest(`http://t/api/sync/pull?${query}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const res = await GET(req);
  return { status: res.status, body: await res.json() };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-sync-pull-"));
  const url = "file:" + join(dir, "test.db");
  client = createClient({ url });
  await applyMigrations(client);
  db = drizzle(client, { schema: s });
  // lib/db.ts reads DATABASE_URL at module load — set it before the dynamic imports.
  process.env.DATABASE_URL = url;

  GET = (await import("@/app/api/sync/pull/route")).GET;
  POST_enroll = (await import("@/app/api/sync/enroll/route")).POST;

  await db.insert(s.companies).values({
    id: companyId,
    name: "Sync Pull Co",
    trialEndsAt: new Date(Date.now() + 30 * 86_400_000),
  });
  await setupCompany(db, companyId);
  await db.insert(s.users).values({
    id: ownerId,
    companyId,
    name: "Owner",
    email: "owner@pulltest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "OWNER",
  });
  await db.insert(s.users).values({
    id: staffId,
    companyId,
    name: "Staff",
    email: "staff@pulltest.pk",
    passwordHash: bcrypt.hashSync(PASSWORD, 4),
    role: "STAFF",
  });
  await db.insert(s.userPermissions).values({
    userId: staffId,
    companyId,
    permission: "parties",
    grantedAt: new Date(),
  });

  await db.insert(s.parties).values({
    id: partyId,
    companyId,
    kind: "CUSTOMER",
    name: "Pull Party",
    creditLimit: 0n,
  });
  await db.insert(s.products).values({
    id: productId,
    companyId,
    sku: "PULL-1",
    name: "Pull Product",
    unit: "PCS",
    trackStock: false,
  });

  ownerToken = await enroll("owner@pulltest.pk", "Owner Tablet");
  staffToken = await enroll("staff@pulltest.pk", "Staff Phone");
});

afterAll(() => {
  client?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("GET /api/sync/pull", () => {
  it("returns parties with ms-integer timestamps, decimal-string money, grants and serverTime", async () => {
    const { status, body } = await pull(ownerToken, "cursors=0");
    expect(status).toBe(200);
    expect(typeof body.serverTime).toBe("number");
    expect(Array.isArray(body.grants)).toBe(true);
    expect(body.grants).toContain("sales");

    const party = body.tables.parties.rows.find((r: Record<string, unknown>) => r.id === partyId);
    expect(party).toBeTruthy();
    expect(typeof party.updatedAt).toBe("number");
    expect(Number.isInteger(party.updatedAt)).toBe(true);
    expect(typeof party.createdAt).toBe("number");
    expect(party.balance).toBe("0"); // BigInt → decimal string
    expect(party.creditLimit).toBe("0");
  });

  it("returns no rows and hasMore=false on a second pull with an up-to-date cursor", async () => {
    const first = await pull(ownerToken, "cursors=0");
    const cursor = first.body.tables.parties.cursor;
    expect(typeof cursor).toBe("number");

    const { body } = await pull(ownerToken, `cursors=parties:${cursor}`);
    expect(body.tables.parties.rows).toHaveLength(0);
    expect(body.tables.parties.hasMore).toBe(false);
  });

  it("paginates: hasMore=true until the cursor drains", async () => {
    const base = Date.now() + 10_000;
    for (let i = 0; i < 3; i++) {
      await db.insert(s.parties).values({
        id: crypto.randomUUID(),
        companyId,
        kind: "CUSTOMER",
        name: `Page Party ${i}`,
        updatedAt: new Date(base + i * 1000),
      });
    }

    const p1 = await pull(ownerToken, "cursors=parties:0&limit=2");
    expect(p1.body.tables.parties.rows).toHaveLength(2);
    expect(p1.body.tables.parties.hasMore).toBe(true);

    const p2 = await pull(ownerToken, `cursors=parties:${p1.body.tables.parties.cursor}&limit=2`);
    expect(p2.body.tables.parties.hasMore).toBe(false);
    expect(p2.body.tables.parties.rows.length).toBeGreaterThan(0);

    // 1 fixture party + 3 paged parties = all drained across the two pages.
    expect(p1.body.tables.parties.rows.length + p2.body.tables.parties.rows.length).toBe(4);
  });

  it("surfaces tombstones with table, rowId and deletedAt", async () => {
    const rowId = crypto.randomUUID();
    await db.insert(s.syncTombstones).values({
      id: crypto.randomUUID(),
      companyId,
      tableName: "products",
      rowId,
      deletedAt: new Date(),
      deletedBy: ownerId,
    });

    const { body } = await pull(ownerToken, "tombstones=0");
    const t = body.tombstones.find((x: Record<string, unknown>) => x.rowId === rowId);
    expect(t).toBeTruthy();
    expect(t.table).toBe("products");
    expect(typeof t.deletedAt).toBe("number");
  });

  it("omits permission-gated tables the device may not see", async () => {
    const { status, body } = await pull(staffToken, "cursors=0");
    expect(status).toBe(200);
    expect(body.tables.parties).toBeTruthy(); // staff has the "parties" grant
    expect("sales_docs" in body.tables).toBe(false);
    expect("purchase_docs" in body.tables).toBe(false);
    expect("payments" in body.tables).toBe(false);
  });

  it("never exposes password or recovery-code hashes in users rows", async () => {
    const { body } = await pull(ownerToken, "cursors=0");
    expect(body.tables.users.rows.length).toBeGreaterThan(0);
    for (const u of body.tables.users.rows) {
      expect("passwordHash" in u).toBe(false);
      expect("recoveryCodeHash" in u).toBe(false);
    }
  });
});
