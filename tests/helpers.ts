import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";

export type TestDb = LibSQLDatabase<typeof schema>;

const MIGRATION_SQL = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations", "0001_init.sql"),
  "utf8"
);

export async function createTestDb(): Promise<{ db: TestDb; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
  const client: Client = createClient({ url: "file:" + join(dir, "test.db") });
  const statements = MIGRATION_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const s of statements) {
    await client.execute(s);
  }
  const db = drizzle(client, { schema });
  return {
    db,
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
