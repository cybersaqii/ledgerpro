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
  // Table-rebuild migrations DROP tables other tables still reference; with
  // enforcement on, the DROP is blocked by restrict children (see 0065).
  // Disable for the migration run only, then re-enable so tests run with
  // the same enforcement the app gets from createForeignKeyClient.
  await client.execute("PRAGMA foreign_keys=OFF");
  const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    // Strip `--` line comments before splitting so semicolons inside comments
    // never break statement splitting.
    const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf8")
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("--");
        return idx >= 0 ? line.slice(0, idx) : line;
      })
      .join("\n");
    const statements = sql.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
    for (const s of statements) {
      await client.execute(s);
    }
  }
  await client.execute("PRAGMA foreign_keys=ON");
  const db = drizzle(client, { schema });
  return {
    db,
    cleanup: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
