import { NextRequest } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { syncOperations } from "@/db/schema";
import { db } from "@/lib/db";
import { json } from "@/lib/api";
import { deviceCan, requireDevice } from "@/lib/sync-auth";
import {
  applySyncOp,
  isUuid,
  permForKind,
  SYNC_OP_KINDS,
  type ApplyResult,
  type SyncOp,
} from "@/lib/sync-apply";

// Push operations are domain actions, not raw table upserts — each kind maps
// to the existing route validator + service function (design §4), so the
// server re-posts everything with zero duplicated business logic.
const opSchema = z.object({
  opId: z.string().min(1).max(40),
  kind: z.enum(SYNC_OP_KINDS),
  refId: z.string().min(1).max(40),
  baseUpdatedAt: z.number().int().min(0).default(0),
  clientUpdatedAt: z.number().int().min(0),
  payload: z.unknown(),
});

const envelopeSchema = z.object({
  deviceId: z.string().max(40).optional(),
  clientTime: z.number().int().min(0).optional(),
  operations: z.array(opSchema).min(1).max(500),
});

function payloadDocType(payload: unknown): string | undefined {
  if (payload && typeof payload === "object" && "docType" in payload) {
    const dt = (payload as { docType?: unknown }).docType;
    return typeof dt === "string" ? dt : undefined;
  }
  return undefined;
}

// POST /api/sync/push — apply a batch of offline operations.
// Auth: Bearer dvt_ device token (requireDevice re-reads user, grants and
// billing live, and gates the whole surface on TRIAL-or-PRO). Always answers
// HTTP 200 for an authenticated batch; failures are per-op `rejected` results.
export async function POST(req: NextRequest) {
  const gate = await requireDevice(req);
  if (!gate.ok) return gate.response;
  const ds = gate.ds;

  const body = await req.json().catch(() => null);
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) {
    return json({ error: "Invalid sync payload.", code: "INVALID_ENVELOPE" }, { status: 422 });
  }

  const results: (ApplyResult & { opId: string; replayed?: boolean })[] = [];

  // Ops apply SEQUENTIALLY in array order; later ops see earlier ops'
  // committed rows (client UUIDs as PKs make intra-batch references work).
  // One transaction per op: a single bad op is rejected, the rest still apply.
  for (const raw of parsed.data.operations) {
    const op: SyncOp = raw;
    let result: ApplyResult;
    let replayed = false;

    // (a) opId/refId must be UUIDs.
    if (!isUuid(op.opId) || !isUuid(op.refId)) {
      result = {
        status: "rejected",
        refId: op.refId,
        error: { code: "INVALID_ID", message: "opId and refId must be UUIDs." },
      };
    } else {
      // (b) idempotency: a retried opId returns the stored result without re-applying.
      const [prior] = await db
        .select()
        .from(syncOperations)
        .where(eq(syncOperations.opId, op.opId))
        .limit(1);
      if (prior) {
        if (prior.companyId !== ds.companyId) {
          result = {
            status: "rejected",
            refId: op.refId,
            error: {
              code: "OP_CONFLICT",
              message: "This operation id was already used by another company.",
            },
          };
        } else {
          try {
            const stored = JSON.parse(prior.result || "{}") as ApplyResult;
            result = { ...stored, refId: stored.refId || op.refId };
            replayed = true;
          } catch {
            result = {
              status: "rejected",
              refId: op.refId,
              error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
            };
          }
        }
      } else {
        // (c) live permission re-check per kind (owners bypass, like the web).
        const perm = permForKind(op.kind, payloadDocType(op.payload));
        if (!deviceCan(ds, perm)) {
          result = {
            status: "rejected",
            refId: op.refId,
            error: {
              code: "FORBIDDEN_PERMISSION",
              message: "You don't have permission to do this. Ask your owner to grant access.",
            },
          };
        } else {
          // (d) apply in its own transaction.
          try {
            result = await applySyncOp(db, ds, op);
          } catch (e) {
            // (f) never leak internals; the batch continues.
            console.error("[sync/push] unexpected apply error", op.opId, op.kind, e);
            result = {
              status: "rejected",
              refId: op.refId,
              error: { code: "INTERNAL", message: "Something went wrong. Please try again." },
            };
          }
        }
      }
    }

    // (e) record the opId → result mapping for replay. The stored JSON holds
    // everything the client needs (serverRow etc.). Best-effort after apply:
    // a lost record only costs idempotency, never correctness.
    if (!replayed) {
      try {
        await db.insert(syncOperations).values({
          opId: op.opId,
          deviceId: ds.deviceId,
          companyId: ds.companyId,
          userId: ds.userId,
          kind: op.kind,
          refId: op.refId,
          status: result.status,
          result: JSON.stringify(result),
        });
      } catch (e) {
        // Concurrent duplicate submit: fall back to the stored result.
        const [dup] = await db
          .select()
          .from(syncOperations)
          .where(eq(syncOperations.opId, op.opId))
          .limit(1);
        if (dup && dup.companyId === ds.companyId) {
          try {
            const stored = JSON.parse(dup.result || "{}") as ApplyResult;
            result = { ...stored, refId: stored.refId || op.refId };
            replayed = true;
          } catch {
            /* keep the freshly computed result */
          }
        } else {
          console.error("[sync/push] failed to record op", op.opId, e);
        }
      }
    }

    results.push({ ...result, opId: op.opId, ...(replayed ? { replayed: true } : {}) });
  }

  return json({ serverTime: Date.now(), results });
}
