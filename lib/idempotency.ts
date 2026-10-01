import { and, eq } from "drizzle-orm";
import {
  salesDocs,
  purchaseDocs,
  payments,
  expenses,
  transfers,
  writeOffs,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { UserError } from "./errors";
import { rateLimitDb } from "./rate-limit-db";

/**
 * Idempotency for money-moving creates (migration 0031).
 *
 * The client generates ONE key per user submission (crypto.randomUUID) and
 * sends it as `idempotencyKey` (JSON body) or the `X-Idempotency-Key` header.
 * The server:
 *   1. looks up (companyId, key) first — a hit returns the existing doc with
 *      HTTP 200 instead of creating a duplicate;
 *   2. otherwise inserts with the key stored, so a lost race on the partial
 *      unique index is caught, re-read, and also answered 200.
 * Clients that send no key get the old behavior (HTTP 201, no index entry).
 */

/** Client idempotency keys are capped at 64 chars (fits the index, cheap to compare). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 64;

/** Throttle for money-moving creates: 60/min per user+company+route. */
export const MONEY_CREATE_LIMIT = 60;
export const MONEY_CREATE_WINDOW_MS = 60_000;

export type IdempotencyTable =
  | typeof salesDocs
  | typeof purchaseDocs
  | typeof payments
  | typeof expenses
  | typeof transfers
  | typeof writeOffs;

/**
 * Extract the idempotency key from the `X-Idempotency-Key` header (wins when
 * both are present) or the `idempotencyKey` JSON body field. Returns
 * undefined when the client sent none. Throws UserError (422) when the key
 * is present but malformed.
 */
export function extractIdempotencyKey(req: Request, body: unknown): string | undefined {
  const header = req.headers.get("x-idempotency-key")?.trim();
  let raw: unknown = header || undefined;
  if (raw === undefined && body !== null && typeof body === "object") {
    raw = (body as { idempotencyKey?: unknown }).idempotencyKey;
  }
  if (raw === undefined || raw === null) return undefined;
  const key = String(raw).trim();
  if (key.length === 0) return undefined;
  if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH || !/^[\x20-\x7E]+$/.test(key)) {
    throw new UserError("Invalid idempotency key.", 422, "INVALID_IDEMPOTENCY_KEY");
  }
  return key;
}

/** Minimal replay shape shared by every idempotent money route. */
export type IdempotentHit = { id: string; docNo: string | null };

/** Find a doc already created with this idempotency key (same company). */
export async function findByIdempotencyKey(
  dbx: Db | DbTx,
  table: IdempotencyTable,
  companyId: string,
  key: string
): Promise<IdempotentHit | null> {
  const rows = await dbx
    .select({ id: table.id, docNo: table.docNo })
    .from(table)
    .where(and(eq(table.companyId, companyId), eq(table.idempotencyKey, key)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * True when the error is a unique-violation on one of the idempotency
 * partial indexes — i.e. a concurrent request won the race for this key.
 * Callers re-read and answer 200 when the row exists, and rethrow otherwise.
 */
export function isIdempotencyConflict(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur != null; i++) {
    const msg = cur instanceof Error ? cur.message : typeof cur === "string" ? cur : "";
    if (typeof msg === "string" && msg.includes("idempotency_key")) {
      if (msg.includes("UNIQUE constraint failed")) return true;
      const code = (cur as { code?: unknown } | null)?.code;
      if (typeof code === "string" && code.includes("UNIQUE")) return true;
    }
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  return false;
}

/**
 * Per-user+company throttle for money-moving creates. Fails open (allows)
 * when the rate-limit store is unreachable, so a DB hiccup never locks
 * users out of the POS.
 */
export async function throttleMoneyCreate(
  dbx: Db,
  route: string,
  uid: string,
  companyId: string
): Promise<{ ok: boolean; retryAfterSec: number }> {
  return rateLimitDb(
    `money-create:${route}:${companyId}:${uid}`,
    MONEY_CREATE_LIMIT,
    MONEY_CREATE_WINDOW_MS,
    dbx
  );
}
