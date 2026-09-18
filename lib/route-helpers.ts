import { eq, and } from "drizzle-orm";
import { branches } from "@/db/schema";
import { requireAuth, err } from "./api";
import type { Session } from "./auth";
import type { Db, DbTx } from "./db";
import { db } from "./db";
import type { NextResponse } from "next/server";

/** Parse "YYYY-MM-DD" as UTC noon (avoids timezone/DST edge cases). */
export function parseDateOnly(s: string): Date {
  const d = new Date(`${s}T12:00:00Z`);
  if (isNaN(d.getTime())) throw new Error("Invalid date");
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
  if (!rows[0]) throw new Error("Invalid branch");
}

export { db, err };
export type { Db };
