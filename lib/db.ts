import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
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

function createDb(): Db {
  const { url, authToken } = resolveDb();
  const client = createClient({ url, authToken });
  return drizzle(client, { schema });
}

export const db: Db = globalForDb.db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.db = db;
}
