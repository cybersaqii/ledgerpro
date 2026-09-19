import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient, type Client } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import * as schema from "@/db/schema";

export type TestDb = LibSQLDatabase<typeof schema>;

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export async function createTestDb(): Promise<{ db: TestDb; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "lp-test-"));
  const client: Client = createClient({ url: "file:" + join(dir, "test.db") });
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const statements = readFileSync(join(MIGRATIONS_DIR, f), "utf8").split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const s of statements) {
      await client.execute(s);
    }
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
