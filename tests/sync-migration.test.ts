import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function indexNames(): Promise<string[]> {
  const r = await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'index'`);
  return (r as unknown as { rows: { name: string }[] }).rows.map((x) => x.name);
}

async function tableNames(): Promise<string[]> {
  const r = await db.run(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
  return (r as unknown as { rows: { name: string }[] }).rows.map((x) => x.name);
}

async function columnNames(table: string): Promise<string[]> {
  const r = await db.run(sql.raw(`PRAGMA table_info(${table})`));
  return (r as unknown as { rows: { name: string }[] }).rows.map((x) => x.name);
}

describe("0019_sync_foundation migration", () => {
  it("creates the sync_tombstones, device_tokens and sync_operations tables", async () => {
    const names = await tableNames();
    expect(names).toContain("sync_tombstones");
    expect(names).toContain("device_tokens");
    expect(names).toContain("sync_operations");
  });

  it("adds updated_at to every table that lacked it", async () => {
    const tables = [
      "branches",
      "accounts",
      "bank_accounts",
      "price_lists",
      "payments",
      "expenses",
      "settings",
      "held_bills",
    ];
    for (const t of tables) {
      expect(await columnNames(t), `updated_at missing on ${t}`).toContain("updated_at");
    }
  });

  it("creates the pull-cursor indexes", async () => {
    const names = await indexNames();
    for (const idx of [
      "sales_docs_company_updated",
      "purchase_docs_company_updated",
      "payments_company_updated",
      "expenses_company_updated",
      "parties_company_updated",
      "products_company_updated",
    ]) {
      expect(names, `index ${idx} missing`).toContain(idx);
    }
  });

  it("creates the tombstone uniqueness and device-token indexes", async () => {
    const names = await indexNames();
    expect(names).toContain("sync_tombstones_unique");
    expect(names).toContain("sync_tombstones_company_time");
    expect(names).toContain("device_tokens_user");
    expect(names).toContain("device_tokens_company");
    expect(names).toContain("sync_operations_device");
  });
});
