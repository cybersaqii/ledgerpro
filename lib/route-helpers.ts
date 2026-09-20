import { eq, and } from "drizzle-orm";
import { branches, users } from "@/db/schema";
import { requireAuth, err, json } from "./api";
import type { Session } from "./auth";
import type { Db, DbTx } from "./db";
import { db } from "./db";
import type { NextResponse } from "next/server";
import { UserError } from "./errors";
import { userHasPermission, type Permission } from "./permissions";

/** Parse "YYYY-MM-DD" as UTC noon (avoids timezone/DST edge cases). */
export function parseDateOnly(s: string): Date {
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime())) throw new UserError("Invalid date");
  return d;
}

/** Auth + company scoping for API routes.
 *  Usage: const gate = await requireCompany(); if (!gate.ok) return gate.response; */
export async function requireCompany(): Promise<
  | { ok: true; session: Session; companyId: string; response: null }
  | { ok: false; session: null; companyId: null; response: NextResponse }
> {
  const { session, response } = await requireAuth();
  if (!session) return { ok: false, session: null, companyId: null, response: response as NextResponse };
  return { ok: true, session, companyId: session.cid, response: null };
}

/** Auth + OWNER role + company scoping for API routes (settings, team).
 *  The role is re-read from the database so a demoted owner loses access
 *  immediately instead of keeping it until their JWT expires. */
export async function requireOwner(): Promise<
  | { ok: true; session: Session; companyId: string; response: null }
  | { ok: false; session: null; companyId: null; response: NextResponse }
> {
  const gate = await requireCompany();
  if (!gate.ok) return gate;
  const [u] = await db
    .select({ role: users.role, isActive: users.isActive, companyId: users.companyId })
    .from(users)
    .where(eq(users.id, gate.session.uid))
    .limit(1);
  if (!u || !u.isActive || u.companyId !== gate.companyId || u.role !== "OWNER") {
    return { ok: false, session: null, companyId: null, response: err("Only the owner can do this.", 403) };
  }
  return gate;
}

/**
 * Auth + granular permission + company scoping for API routes.
 * Owners implicitly hold every permission; staff need an explicit grant
 * (see lib/permissions.ts). Reads the live role/grant set from the database
 * so changes take effect immediately.
 */
export async function requirePermission(
  permission: Permission
): Promise<
  | { ok: true; session: Session; companyId: string; response: null }
  | { ok: false; session: null; companyId: null; response: NextResponse }
> {
  const gate = await requireCompany();
  if (!gate.ok) return gate;
  const allowed = await userHasPermission(db, gate.session.uid, permission);
  if (!allowed) {
    return {
      ok: false,
      session: null,
      companyId: null,
      response: json(
        {
          error: "You don't have permission to do this. Ask your owner to grant access.",
          code: "FORBIDDEN_PERMISSION",
          permission,
        },
        { status: 403 }
      ),
    };
  }
  return gate;
}

/** Default branch for the company (created at signup). */
export async function defaultBranchId(tx: Db | DbTx, companyId: string): Promise<string> {
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.companyId, companyId), eq(branches.isDefault, true)))
    .limit(1);
  if (!rows[0]) throw new Error("No branch found for company");
  return rows[0].id;
}

/** Verify a branch belongs to the company. */
export async function assertBranch(tx: Db | DbTx, companyId: string, branchId: string): Promise<void> {
  const rows = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(eq(branches.id, branchId), eq(branches.companyId, companyId)))
    .limit(1);
  if (!rows[0]) throw new UserError("Invalid branch");
}

export { db, err };
export type { Db };
