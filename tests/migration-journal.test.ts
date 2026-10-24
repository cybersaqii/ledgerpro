/**
 * Phase P3, item 4: tests for scripts/verify-migrations.mjs.
 *
 * The script is the migration journal check (no drizzle-kit, no CI in
 * this repo). These tests run it as a subprocess against fixture
 * migration dirs and prove it:
 *   - passes a good sequential set and a fresh apply,
 *   - fails loudly on a numbering gap,
 *   - fails loudly on journal drift (an existing DB whose
 *     schema_migrations rows do not match the files — the 0054-style
 *     drift the audit found),
 *   - passes on the real db/migrations directory.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { createClient } from "@libsql/client";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "verify-migrations.mjs");

function runScript(args: string[]): { status: number; output: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, output: out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { status: err.status ?? -1, output: `${err.stdout ?? ""}\n${err.stderr ?? ""}` };
  }
}

function fixtureDir(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "lp-verify-fixture-"));
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(dir, name), sql);
  return dir;
}

const GOOD = {
  "0001_create_a.sql": "CREATE TABLE a (id TEXT PRIMARY KEY, v INTEGER);",
  "0002_create_b.sql": "CREATE TABLE b (id TEXT PRIMARY KEY, a_id TEXT REFERENCES a(id));",
};

describe("verify-migrations script", () => {
  it("passes a good sequential set", () => {
    const dir = fixtureDir(GOOD);
    try {
      const r = runScript(["--migrations-dir", dir]);
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/OK/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on a numbering gap", () => {
    const dir = fixtureDir({
      "0001_create_a.sql": GOOD["0001_create_a.sql"],
      "0003_create_c.sql": "CREATE TABLE c (id TEXT PRIMARY KEY);",
    });
    try {
      const r = runScript(["--migrations-dir", dir]);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/gap/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails loudly on journal drift in an existing DB", async () => {
    const dir = fixtureDir(GOOD);
    const dbDir = mkdtempSync(join(tmpdir(), "lp-verify-drift-"));
    const dbPath = join(dbDir, "drift.db");
    try {
      // Simulate the 0054-style drift: the DB journal stops at 0001 while
      // the files already contain 0002.
      const client = createClient({ url: "file:" + dbPath });
      await client.execute(
        "CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"
      );
      await client.execute({
        sql: "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        args: ["0001_create_a", Date.now()],
      });
      client.close();
      const r = runScript(["--migrations-dir", dir, "--db", dbPath]);
      expect(r.status).not.toBe(0);
      expect(r.output).toMatch(/drift|not recorded/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(dbDir, { recursive: true, force: true });
    }
  });

  it("passes on the real db/migrations directory", () => {
    const r = runScript([]);
    expect(r.status).toBe(0);
    expect(r.output).toMatch(/OK/);
  });
});
