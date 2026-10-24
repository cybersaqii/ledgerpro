/**
 * Phase P0 foreign-key self-test (local SQLite only).
 *
 * Builds a scratch database from every migration in db/migrations/ through
 * the same factory the app singleton uses (createForeignKeyClient in
 * lib/db.ts), then asserts behavioral enforcement, not just the pragma:
 *  - a child row naming a bogus parent FAILS,
 *  - deleting a still-referenced parent FAILS,
 *  - a child inserted before its parent inside one transaction COMMITS
 *    (the 0023/0065 references are DEFERRABLE INITIALLY DEFERRED),
 *  - no rebuilt table carries CASCADE / SET NULL / SET DEFAULT anymore,
 *  - user_companies.created_at defaults per row, in milliseconds, both
 *    through drizzle ($defaultFn) and through a raw-SQL insert (the 0066
 *    DDL default).
 *
 * Remote Turso is deliberately NOT covered here: over HTTP every execute()
 * runs on its own pooled connection, so a pragma cannot be proven from a
 * test client. See the transport note in lib/db.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import * as schema from "@/db/schema";
import { createForeignKeyClient, isForeignKeysEnabled } from "@/lib/db";
import type { Client } from "@libsql/client";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

const REBUILT_TABLES = [
  "price_list_items",
  "price_list_uom_rates",
  "user_permissions",
  "report_favorites",
  "reconciliation_clears",
  "notes",
  "recurring_runs",
  "ip_bypass_users",
  "expenses",
  "transfers",
  "sundry_receipts",
  "bank_statement_lines",
  "bank_statements",
  "bank_adjustments",
];

let dir: string;
let client: Client;
let db: LibSQLDatabase<typeof schema>;

async function applyMigrations(c: Client) {
  // Same documented rebuild procedure as scripts/migrate.mjs: DROP TABLE
  // of a referenced parent is blocked while enforcement is on, so the
  // migration run itself executes with enforcement off, then back on.
  await c.execute("PRAGMA foreign_keys=OFF");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    for (const s of sql.split(";").map((x) => x.trim()).filter(Boolean)) {
      await c.execute(s);
    }
  }
  await c.execute("PRAGMA foreign_keys=ON");
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "lp-fk-test-"));
  const { client: c, ready } = createForeignKeyClient({ url: "file:" + join(dir, "test.db") });
  client = c;
  expect(await ready).toBe(true);
  expect(await isForeignKeysEnabled(client)).toBe(true);
  await applyMigrations(client);
  // The pragma survives the migration run on a local file client.
  expect(await isForeignKeysEnabled(client)).toBe(true);
  db = drizzle(client, { schema });
}, 60000);

afterAll(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("foreign-key enforcement", () => {
  it("rejects a child row naming a bogus parent", async () => {
    await client.execute({
      sql: "INSERT INTO companies (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)",
      args: ["c-fk", "FK Test Co", Date.now(), Date.now()],
    });
    await client.execute({
      sql: "INSERT INTO price_lists (id, company_id, name, created_at) VALUES (?, ?, ?, ?)",
      args: ["pl-fk", "c-fk", "List", Date.now()],
    });
    await expect(
      client.execute({
        sql: "INSERT INTO price_list_items (id, price_list_id, product_id, rate) VALUES (?, ?, ?, ?)",
        args: ["pli-bogus", "no-such-list", "p1", 100],
      })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("rejects deleting a still-referenced parent", async () => {
    await client.execute({
      sql: "INSERT INTO price_list_items (id, price_list_id, product_id, rate) VALUES (?, ?, ?, ?)",
      args: ["pli-ok", "pl-fk", "p1", 100],
    });
    await expect(
      client.execute({ sql: "DELETE FROM price_lists WHERE id = ?", args: ["pl-fk"] })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    // Child-then-parent delete still succeeds.
    await client.execute({ sql: "DELETE FROM price_list_items WHERE id = ?", args: ["pli-ok"] });
    await client.execute({ sql: "DELETE FROM price_lists WHERE id = ?", args: ["pl-fk"] });
  });

  it("defers the check to COMMIT inside a transaction (DEFERRABLE INITIALLY DEFERRED)", async () => {
    const tx = await client.transaction("write");
    try {
      await tx.execute({
        sql: "INSERT INTO price_list_items (id, price_list_id, product_id, rate) VALUES (?, ?, ?, ?)",
        args: ["pli-deferred", "pl-pending", "p1", 100],
      });
      await tx.execute({
        sql: "INSERT INTO price_lists (id, company_id, name, created_at) VALUES (?, ?, ?, ?)",
        args: ["pl-pending", "c-fk", "Pending List", Date.now()],
      });
      await tx.commit();
    } catch (e) {
      await tx.rollback().catch(() => undefined);
      throw e;
    }
    const rows = await client.execute({
      sql: "SELECT id FROM price_list_items WHERE id = ?",
      args: ["pli-deferred"],
    });
    expect(rows.rows.length).toBe(1);
  });

  it("fails COMMIT when a deferred child still has no parent", async () => {
    const tx = await client.transaction("write");
    await tx.execute({
      sql: "INSERT INTO price_list_items (id, price_list_id, product_id, rate) VALUES (?, ?, ?, ?)",
      args: ["pli-orphan", "never-exists", "p1", 100],
    });
    await expect(tx.commit()).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("carries no CASCADE / SET NULL / SET DEFAULT on any rebuilt table", async () => {
    for (const table of REBUILT_TABLES) {
      const rs = await client.execute(`PRAGMA foreign_key_list(${table})`);
      expect(rs.rows.length, `${table} should keep at least one FK`).toBeGreaterThan(0);
      for (const row of rs.rows as unknown as Record<string, unknown>[]) {
        expect(String(row.on_delete)).not.toMatch(/CASCADE|SET NULL|SET DEFAULT/);
        expect(String(row.on_update)).not.toMatch(/CASCADE|SET NULL|SET DEFAULT/);
      }
    }
  });
});

describe("user_companies.created_at per-row default (0066)", () => {
  it("fills a fresh millisecond timestamp through drizzle ($defaultFn)", async () => {
    const before = Date.now();
    const [user] = await db
      .insert(schema.users)
      .values({ companyId: "c-fk", name: "FK User", email: "fk@test.local", passwordHash: "x" })
      .returning();
    const [row] = await db
      .insert(schema.userCompanies)
      .values({ userId: user.id, companyId: "c-fk" })
      .returning();
    const after = Date.now();
    const ms = row.createdAt!.getTime();
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after + 1000);
    expect(ms).toBeGreaterThan(1_000_000_000_000);
  });

  it("fills a fresh millisecond timestamp through a raw-SQL insert (DDL default)", async () => {
    const [user2] = await db
      .insert(schema.users)
      .values({ companyId: "c-fk", name: "FK User 2", email: "fk2@test.local", passwordHash: "x" })
      .returning();
    const before = Date.now();
    await client.execute({
      sql: "INSERT INTO user_companies (id, user_id, company_id) VALUES (?, ?, ?)",
      args: ["uc-raw", user2.id, "c-fk"],
    });
    const after = Date.now();
    const rs = await client.execute({
      sql: "SELECT created_at FROM user_companies WHERE id = ?",
      args: ["uc-raw"],
    });
    const ms = Number((rs.rows[0] as Record<string, unknown>).created_at);
    // The DDL default is (strftime('%s','now') * 1000): per-row, but only
    // second-precise, so it may land up to 1s before `before`.
    expect(ms).toBeGreaterThanOrEqual(before - 1000);
    expect(ms).toBeLessThanOrEqual(after + 1000);
    expect(ms).toBeGreaterThan(1_000_000_000_000);
    expect(ms % 1000).toBe(0);
    // And the row is findable through drizzle with the company scope intact.
    const found = await db
      .select()
      .from(schema.userCompanies)
      .where(eq(schema.userCompanies.id, "uc-raw"));
    expect(found.length).toBe(1);
    expect(found[0].companyId).toBe("c-fk");
  });
});
