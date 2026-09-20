// Boots an isolated E2E environment: fresh SQLite file + migrations + next dev.
// Usage: E2E=1 PORT=3100 node scripts/e2e-server.mjs
// The database file e2e-test.db is throwaway and gitignored — never touches dev.db.
import { spawn, execSync } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbFile = join(root, "e2e-test.db");

// Fresh database for every run.
for (const suffix of ["", "-shm", "-wal"]) {
  const f = dbFile + suffix;
  if (existsSync(f)) rmSync(f);
}

process.env.DATABASE_URL = `file:${dbFile}`;
process.env.E2E = "1";
// Never let an E2E run touch the production Turso database.
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;

console.log("[e2e] migrating isolated database...");
execSync("node scripts/migrate.mjs", { cwd: root, stdio: "inherit", env: process.env });

const port = process.env.PORT || "3100";
console.log(`[e2e] starting next dev on :${port} ...`);
const child = spawn(
  "npx",
  ["next", "dev", "--port", port, "--hostname", "127.0.0.1"],
  { cwd: root, stdio: "inherit", env: process.env }
);
child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGTERM", () => child.kill("SIGTERM"));
process.on("SIGINT", () => child.kill("SIGINT"));
