// Applies db/migrations/*.sql in order, tracking in schema_migrations.
// Usage: node scripts/migrate.mjs
import { createClient } from "@libsql/client";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function resolveDb() {
  const turso = process.env.TURSO_DATABASE_URL;
  if (turso) return { url: turso, authToken: process.env.TURSO_AUTH_TOKEN };
  let url = process.env.DATABASE_URL || "file:./dev.db";
  if (url.startsWith("file:") && !url.startsWith("file:/")) {
    url = "file:" + join(root, url.slice("file:".length));
  }
  return { url };
}

const client = createClient(resolveDb());

await client.execute(
  "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
);
const applied = new Set(
  (await client.execute("SELECT version FROM schema_migrations")).rows.map((r) => r.version)
);

const dir = join(root, "db", "migrations");
const files = readdirSync(dir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

let count = 0;
for (const f of files) {
  const version = f.replace(/\.sql$/, "");
  if (applied.has(version)) {
    console.log(`  skip ${version}`);
    continue;
  }
  const text = readFileSync(join(dir, f), "utf8");
  const statements = text
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA/i.test(s));
  // Run sequentially (not batch) so each DDL commits on its own.
  for (const s of statements) {
    await client.execute(s);
  }
  await client.execute({
    sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
    args: [version, Date.now()],
  });
  console.log(`  applied ${version}`);
  count++;
}
console.log(count === 0 ? "Database is up to date." : `Done. Applied ${count} migration(s).`);
client.close();
