import { timingSafeEqual } from "node:crypto";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { backups, companies } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, reportError } from "@/lib/errors";
import { requireOwner } from "@/lib/route-helpers";
import { db } from "@/lib/db";
import { requirePro } from "@/lib/billing-guards";
import { validateBackupPayload, MAX_BACKUP_BYTES } from "@/lib/backup";
import { signRestoreToken, verifyRestoreToken } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { rateLimitDb } from "@/lib/rate-limit-db";
import {
  assertSameCompany,
  assertTypedNameMatches,
  checkRestoreCooldown,
  payloadHash,
  recordRestoreDone,
  restoreCompanyData,
} from "@/lib/restore";

// POST /api/backups/restore — upload a backup JSON and restore it.
//
// Step 1 (multipart/form-data, field `file`): the file is parsed and run
// through the EXACT same dry-run verification as the Verify button. Zero
// writes happen on failure (422 + the validation errors). On success the
// upload is stored as a manual backup and the response carries a verification
// summary plus a short-lived, tightly-bound restore token.
//
// Step 2 (application/json, `{ token, typedName }`): the typed company name
// must match exactly, the token's signature/expiry/binding is checked, and
// only then the restore runs — wipe + re-insert in ONE transaction.
//
// Owner-only, PRO-gated (import_export), rate-limited.

export async function POST(req: NextRequest) {
  const gate = await requireOwner();
  if (!gate.ok) return gate.response;
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;
  const { session, companyId } = gate;

  const contentType = req.headers.get("content-type") || "";
  try {
    if (contentType.includes("multipart/form-data")) {
      return await handleUpload(req, session, companyId);
    }
    return await handleConfirm(req, session, companyId);
  } catch (e) {
    return toApiError(e, { route: "/api/backups/restore", companyId });
  }
}

interface RestoreSession {
  uid: string;
  cid: string;
  name: string;
}

// ─── Step 1: upload + verify (zero writes on failure) ────────────

async function handleUpload(req: NextRequest, session: RestoreSession, companyId: string) {
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err("Choose a backup JSON file to upload.", 422);
  if (file.size > MAX_BACKUP_BYTES) return err("That file is bigger than 8 MB — backups are limited to 8 MB.", 422);
  const raw = await file.text().catch(() => "");
  if (!raw.trim()) return err("The file is empty.", 422);

  const v = validateBackupPayload(raw);
  if (!v.ok) {
    return json({ error: "This backup file cannot be restored.", data: { errors: v.errors } }, { status: 422 });
  }
  const doc = JSON.parse(raw) as { company?: { id?: unknown; name?: unknown } | null; exportedAt?: unknown };
  assertSameCompany(doc, companyId);

  // Store the verified upload as a manual backup (manual backups are never
  // auto-deleted) so the confirm step restores from a server-side copy the
  // client cannot tamper with.
  const backupId = crypto.randomUUID();
  await db.insert(backups).values({
    id: backupId,
    companyId,
    byteSize: Buffer.byteLength(raw, "utf8"),
    rowCounts: JSON.stringify(v.rowCounts),
    payload: raw,
    trigger: "manual",
  });

  const token = await signRestoreToken({
    uid: session.uid,
    cid: companyId,
    rid: backupId,
    hash: payloadHash(raw),
  });

  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "backup.upload_verified",
    entity: "backup",
    entityId: backupId,
    detail: `Backup uploaded and verified — ready to restore (${totalRows(v.rowCounts)} records).`,
  });

  return json({
    data: {
      backupId,
      token,
      exportedAt: typeof doc.exportedAt === "string" ? doc.exportedAt : null,
      companyName: doc.company && typeof doc.company.name === "string" ? doc.company.name : null,
      rowCounts: v.rowCounts,
    },
  });
}

// ─── Step 2: confirm + restore ───────────────────────────────────

async function handleConfirm(req: NextRequest, session: RestoreSession, companyId: string) {
  const body = (await req.json().catch(() => null)) as { token?: unknown; typedName?: unknown } | null;
  const token = body?.token;
  const typedName = body?.typedName;
  if (typeof token !== "string" || token.length === 0) {
    return err("Your restore session expired. Upload the backup file again.", 400);
  }

  const rl = await rateLimitDb(`restore:${companyId}`, 5, 3_600_000);
  if (!rl.ok) {
    return err(`Too many restore attempts. Please wait ${rl.retryAfterSec} seconds and try again.`, 429);
  }

  const claims = await verifyRestoreToken(token);
  if (!claims || claims.uid !== session.uid || claims.cid !== companyId) {
    return err("This restore link is invalid or has expired. Upload the backup file again.", 401);
  }

  // Load the server-side copy and prove it is byte-identical to what was verified.
  const rows = await db
    .select({ payload: backups.payload })
    .from(backups)
    .where(and(eq(backups.id, claims.rid), eq(backups.companyId, companyId)))
    .limit(1);
  const stored = rows[0]?.payload;
  if (!stored) return err("The uploaded backup is no longer available. Upload it again.", 404);
  const actual = Buffer.from(payloadHash(stored), "utf8");
  const expected = Buffer.from(claims.hash, "utf8");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return err("The backup changed after verification. Upload it again to be safe.", 409);
  }

  // Re-validate from the stored copy (defense in depth) and re-check ownership.
  const v = validateBackupPayload(stored);
  if (!v.ok) {
    return json({ error: "This backup file cannot be restored.", data: { errors: v.errors } }, { status: 422 });
  }
  const doc = JSON.parse(stored) as { company?: { id?: unknown; name?: unknown } | null; exportedAt?: unknown };
  assertSameCompany(doc, companyId);

  const crows = await db
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const currentName = crows[0]?.name ?? "";
  assertTypedNameMatches(typedName, currentName);

  if (await checkRestoreCooldown(db, companyId)) {
    return err("A restore just finished — wait a few seconds before restoring again.", 429);
  }

  const total = totalRows(v.rowCounts);
  const detail =
    `Restored from backup taken ${typeof doc.exportedAt === "string" ? doc.exportedAt : "unknown time"} — ` +
    `${total} records across ${Object.keys(v.rowCounts).length} sections. Previous data was replaced.`;

  // ONE transaction: wipe + re-insert. Any failure rolls everything back and
  // the company is untouched. The audit entry is written before the wipe (so
  // it gets wiped with everything else) and mirrored to the global error_logs
  // with companyId NULL so it survives — same pattern as company deletion.
  await db.transaction(async (tx) => {
    await logAudit(tx, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "backup.restored",
      entity: "backup",
      entityId: claims.rid,
      detail,
    });
    await reportError(
      { route: "/api/backups/restore", message: `backup.restored for company ${companyId}: ${detail}`, companyId: null },
      tx
    );
    await restoreCompanyData(tx, companyId, doc);
  });
  await recordRestoreDone(db, companyId);

  return json({ data: { ok: true, rowCounts: v.rowCounts, total } });
}

function totalRows(rowCounts: Record<string, number>): number {
  return Object.values(rowCounts).reduce((a, n) => a + n, 0);
}
