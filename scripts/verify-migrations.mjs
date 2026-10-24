// Verifies the hand-rolled migration journal (Phase P3, item 4).
//
// There is no drizzle-kit journal in this repo (migrations are hand-rolled
// SQL in db/migrations/, tracked in the schema_migrations table by
// scripts/migrate.mjs), and no CI exists to check one in, so this script
// IS the journal check. Run it with:
//
//   npm run db:verify-migrations
//
// It fails loudly (non-zero exit) when any of these hold:
//
//   (a) Migration filenames are not sequential with no gaps: every file
//       must match NNNN_name.sql and the numbers must run 1..N with no
//       gap and no duplicate. A gap is how a half-applied history hides.
//   (b) Fresh-apply check (default): all migrations apply cleanly, in
//       order, to a TEMP database with FKs off (the same conditions as
//       scripts/migrate.mjs), each recording its version row — and the
//       schema_migrations rows afterwards match the migration files
//       exactly. A file that fails to apply, or whose recorded version
//       does not match its filename, breaks this.
//   (c) Drift check (--db <path>): for an EXISTING database, compare its
//       schema_migrations rows against the migration files WITHOUT
//       applying anything. This is the check that catches the 0054-style
//       drift the audit found: a database whose tables came from 0055+
//       while its journal stopped at 0054 reports the missing versions
//       here instead of silently passing as "up to date".
//
// Options:
//   --migrations-dir <path>   directory of *.sql files (default: db/migrations)
//   --db <path>               existing SQLite file to drift-check (read-only
//                             for the journal table; default: fresh temp DB)
//
// The script never writes to a --db database and never touches production:
// pass a local copy if you want to check a production dump.
import { createClient } from "@libsql/client";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function fail(msg) {
  console.error(`verify-migrations: FAIL: ${msg}`);
  process.exit(1);
}

const args = process.argv.slice(2);
let migrationsDir = join(root, "db", "migrations");
let existingDb = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--migrations-dir" && args[i + 1]) migrationsDir = args[++i];
  else if (args[i] === "--db" && args[i + 1]) existingDb = args[++i];
  else fail(`unknown argument: ${args[i]} (usage: --migrations-dir <path> --db <path>)`);
}
if (!existsSync(migrationsDir)) fail(`migrations directory not found: ${migrationsDir}`);

// (a) Sequential filenames, no gaps, no duplicates.
const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
if (files.length === 0) fail(`no *.sql files in ${migrationsDir}`);
const versions = [];
const seen = new Set();
for (const f of files) {
  const m = f.match(/^(\d+)_.*\.sql$/);
  if (!m) fail(`migration filename does not match NNNN_name.sql: ${f}`);
  const n = Number(m[1]);
  if (seen.has(n)) fail(`duplicate migration number ${m[1]} (file ${f})`);
  seen.add(n);
  versions.push({ num: n, version: f.replace(/\.sql$/, ""), file: f });
}
versions.sort((a, b) => a.num - b.num);
for (let i = 0; i < versions.length; i++) {
  if (versions[i].num !== i + 1) {
    fail(
      `migration numbering gap: expected ${String(i + 1).padStart(4, "0")} after ` +
        `${versions[i - 1] ? versions[i - 1].file : "start"}, found ${versions[i].file} ` +
        `(${files.length} files, numbers ${versions[0].num}..${versions[versions.length - 1].num})`
    );
  }
}
const expected = new Set(versions.map((v) => v.version));

// Split one migration file the same way scripts/migrate.mjs does: strip
// `--` line comments, split on `;`, drop empties and PRAGMAs (Turso
// rejects PRAGMA; the runner disables FKs itself instead).
function statementsOf(text) {
  const stripped = text.replace(/--[^\n]*/g, "");
  return stripped.split(";").map((s) => s.trim()).filter((s) => s.length > 0 && !/^PRAGMA/i.test(s));
}

if (existingDb) {
  // (c) Drift check against an existing database — read-only.
  if (!existsSync(existingDb)) fail(`database file not found: ${existingDb}`);
  const client = createClient({ url: "file:" + existingDb });
  let rows;
  try {
    rows = await client.execute("SELECT version FROM schema_migrations");
  } catch {
    client.close();
    fail(`database has no schema_migrations table (never migrated?): ${existingDb}`);
  }
  client.close();
  const recorded = new Set(rows.rows.map((r) => r.version));
  const missing = [...expected].filter((v) => !recorded.has(v));
  const extra = [...recorded].filter((v) => !expected.has(v));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `schema_migrations drift in ${existingDb}: ` +
        (missing.length > 0 ? `versions in files but not recorded: ${missing.join(", ")}. ` : "") +
        (extra.length > 0 ? `versions recorded but no file: ${extra.join(", ")}. ` : "") +
        `The journal does not match the migration files — do not trust "up to date".`
    );
  }
  console.log(`verify-migrations: OK: ${existingDb} journal matches ${files.length} migration files exactly.`);
  process.exit(0);
}

// (b) Fresh-apply check on a temp database.
const dir = mkdtempSync(join(tmpdir(), "lp-verify-migrations-"));
const dbPath = join(dir, "verify.db");
const client = createClient({ url: "file:" + dbPath });
try {
  await client.execute("PRAGMA foreign_keys=OFF");
  await client.execute(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
  );
  for (const v of versions) {
    const text = readFileSync(join(migrationsDir, v.file), "utf8");
    for (const s of statementsOf(text)) await client.execute(s);
    await client.execute({
      sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      args: [v.version, Date.now()],
    });
  }
  const recorded = new Set(
    (await client.execute("SELECT version FROM schema_migrations")).rows.map((r) => r.version)
  );
  const missing = [...expected].filter((v) => !recorded.has(v));
  const extra = [...recorded].filter((v) => !expected.has(v));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      `fresh-apply journal mismatch: ` +
        (missing.length > 0 ? `not recorded: ${missing.join(", ")}. ` : "") +
        (extra.length > 0 ? `unexpectedly recorded: ${extra.join(", ")}. ` : "")
    );
  }
} catch (e) {
  fail(`applying migrations to temp database failed: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  client.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`verify-migrations: OK: ${files.length} migrations sequential (0001..${String(files.length).padStart(4, "0")}), fresh apply clean, journal matches files exactly.`);
