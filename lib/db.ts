import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient, type Client } from "@libsql/client";
import path from "node:path";
import * as schema from "@/db/schema";

function resolveDb() {
  // Production (Vercel): Turso. Local dev: SQLite file.
  const tursoUrl = process.env.TURSO_DATABASE_URL;
  if (tursoUrl) {
    return { url: tursoUrl, authToken: process.env.TURSO_AUTH_TOKEN };
  }
  let url = process.env.DATABASE_URL || "file:./dev.db";
  if (url.startsWith("file:") && !url.startsWith("file:/")) {
    url = "file:" + path.resolve(process.cwd(), url.slice("file:".length));
  }
  return { url };
}

export type Db = LibSQLDatabase<typeof schema>;
export type DbTx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { db?: Db };

/**
 * Foreign-key enforcement (migration program Phase P0).
 *
 * SQLite disables foreign keys by default, and PRAGMA foreign_keys is a
 * PER-CONNECTION setting. What that means per transport, verified against
 * the installed @libsql/client sources (its Client docs state every
 * `execute()` runs on its own logical database connection, and the hrana
 * implementation opens one stream per execute / per transaction):
 *
 * - Local `file:` databases: one persistent connection per client, so a
 *   single PRAGMA foreign_keys=ON at client creation enforces FKs for
 *   every statement and every transaction on that client. Fully enforced.
 * - Remote Turso over HTTP (`https://`) or WebSocket (`libsql://`):
 *   there is NO client-side mechanism in this client version that can
 *   guarantee enforcement. A standalone pragma warms at most one pooled
 *   server connection, and a pragma issued inside a transaction or batch
 *   is a SQLite no-op (foreign_keys may only change outside a transaction).
 *   Enforcement over HTTP is therefore best-effort only: do not rely on
 *   DB-level FK errors in production until the transport question is
 *   settled (server-side sqld configuration, or app-level checks in the
 *   write paths). The boot check below logs a loud warning for remote
 *   transports instead of crashing, by design.
 *
 * scripts/migrate.mjs explicitly DISABLES foreign keys for the migration
 * run and re-enables after: the table-rebuild migrations drop tables that
 * other tables reference, and with enforcement on that DROP is blocked by
 * restrict children even though the rebuild preserves every row.
 */

/** Enable FKs on a client and report whether the setting stuck on the
 * connection the check itself ran on. Best-effort for remote transports
 * (see above); deterministic for local file clients. */
export async function ensureForeignKeys(client: Client): Promise<boolean> {
  try {
    await client.execute("PRAGMA foreign_keys=ON");
    const rs = await client.execute("PRAGMA foreign_keys");
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    return Number(row?.foreign_keys ?? 0) === 1;
  } catch {
    return false;
  }
}

/** Startup self-test: read back the foreign_keys pragma for a client.
 * Returns false (never throws) when the pragma cannot be confirmed, e.g.
 * a remote pooled connection that reports the default OFF. */
export async function isForeignKeysEnabled(client: Client): Promise<boolean> {
  try {
    const rs = await client.execute("PRAGMA foreign_keys");
    const row = rs.rows[0] as Record<string, unknown> | undefined;
    return Number(row?.foreign_keys ?? 0) === 1;
  } catch {
    return false;
  }
}

export interface ForeignKeyClient {
  client: Client;
  /** Resolves true when the creation-time pragma stuck (local file
   * clients). For remote transports this is informational only: a false
   * here does not prove later statements run unenforced, and a true here
   * does not prove they run enforced. */
  ready: Promise<boolean>;
}

/** Create a client with foreign-key enforcement switched on at creation.
 * Use this for every connection path (app singleton below, tests, scripts
 * that need enforced FKs) so the pragma is never forgotten per call site. */
export function createForeignKeyClient(opts: {
  url: string;
  authToken?: string;
}): ForeignKeyClient {
  const client = createClient(opts);
  const ready = ensureForeignKeys(client).catch(() => false);
  return { client, ready };
}

function createDb(): Db {
  const { url, authToken } = resolveDb();
  const { client, ready } = createForeignKeyClient({ url, authToken });
  // Boot check: loud warning, never a crash. Skipped under vitest (the
  // singleton would otherwise open the dev database file during tests;
  // tests build their own clients through createForeignKeyClient).
  if (process.env.NODE_ENV !== "test") {
    void ready.then((ok) => {
      const remote = !url.startsWith("file:");
      if (remote) {
        console.warn(
          "[db] WARNING: foreign-key enforcement over a remote libSQL connection " +
            "cannot be guaranteed per statement (PRAGMA foreign_keys is per pooled " +
            "connection and a no-op inside transactions). Local file connections are " +
            "fully enforced; remote enforcement is best-effort until the transport " +
            "question is settled. Do not rely on DB-level FK errors in production."
        );
      } else if (!ok) {
        console.error(
          "[db] ERROR: PRAGMA foreign_keys=ON did not stick on the local database " +
            "connection. Foreign-key constraints will NOT be enforced."
        );
      }
    });
  }
  return drizzle(client, { schema });
}

export const db: Db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
