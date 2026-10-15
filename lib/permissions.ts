// Granular staff permissions.
//
// Two roles exist on the user row: OWNER and STAFF. Owners implicitly hold
// every permission. Staff members hold an explicit per-permission grant set in
// the `user_permissions` table; the owner edits it from Settings → Team.
//
// Company isolation is preserved because every permission row is scoped to a
// company, and every check re-reads the user's live role from the database
// (never trusting a possibly-stale JWT role claim).
import { eq, and } from "drizzle-orm";
import { users, userCompanies, userPermissions } from "@/db/schema";
import type { Db, DbTx } from "./db";
import {
  STAFF_DEFAULT_PERMISSIONS,
  isPermission,
  type Permission,
} from "./permission-keys";

export {
  PERMISSIONS,
  PERMISSION_GROUPS,
  STAFF_DEFAULT_PERMISSIONS,
  isPermission,
  permissionLabelKey,
  permissionDescKey,
} from "./permission-keys";
export type { Permission } from "./permission-keys";

/** Granted permission keys for a user in one company (empty array for unknown users). */
export async function getUserPermissions(
  dbc: Db | DbTx,
  userId: string,
  companyId: string
): Promise<Permission[]> {
  const rows = await dbc
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.companyId, companyId)
      )
    );
  return rows.map((r) => r.permission).filter(isPermission);
}

/**
 * Replace a staff member's grant set in one company. Unknown keys are
 * rejected; duplicates are collapsed. The target must belong to the company.
 * Owners never need rows (they bypass), but keeping rows for them is harmless.
 * The delete is company-scoped: grants the user holds in OTHER companies are
 * never touched.
 */
export async function setUserPermissions(
  dbc: Db | DbTx,
  args: { companyId: string; userId: string; permissions: string[] }
): Promise<Permission[]> {
  const clean = [...new Set(args.permissions.filter(isPermission))];
  // The target must hold an ACTIVE membership in this company (multi-company:
  // users.companyId is only their primary company).
  const [target] = await dbc
    .select({ id: userCompanies.id })
    .from(userCompanies)
    .where(
      and(
        eq(userCompanies.userId, args.userId),
        eq(userCompanies.companyId, args.companyId),
        eq(userCompanies.isActive, true)
      )
    )
    .limit(1);
  if (!target) throw new Error("User not found in this company");
  await dbc.transaction(async (tx) => {
    await tx
      .delete(userPermissions)
      .where(
        and(
          eq(userPermissions.userId, args.userId),
          eq(userPermissions.companyId, args.companyId)
        )
      );
    for (const p of clean) {
      await tx.insert(userPermissions).values({
        userId: args.userId,
        companyId: args.companyId,
        permission: p,
        grantedAt: new Date(),
      });
    }
  });
  return clean;
}

/**
 * Seed the default staff grants when a user has no explicit rows yet in THIS
 * company (e.g. an OWNER demoted to STAFF, or staff added to a second
 * company). Returns true when rows were inserted.
 */
export async function ensureStaffDefaults(
  dbc: Db | DbTx,
  args: { companyId: string; userId: string }
): Promise<boolean> {
  const existing = await dbc
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, args.userId),
        eq(userPermissions.companyId, args.companyId)
      )
    )
    .limit(1);
  if (existing.length > 0) return false;
  for (const p of STAFF_DEFAULT_PERMISSIONS) {
    await dbc.insert(userPermissions).values({
      userId: args.userId,
      companyId: args.companyId,
      permission: p,
      grantedAt: new Date(),
    });
  }
  return true;
}

/**
 * The security core: does this user hold `permission` in `companyId` right now?
 * Reads the live company-membership row (role + active) and the grant set —
 * never trusts the JWT role claim or the single-company users.role column, so
 * demotions and grant changes take effect immediately, and an OWNER of company
 * A is NOT an owner in company B. Inactive users hold nothing.
 */
export async function userHasPermission(
  dbc: Db | DbTx,
  userId: string,
  permission: Permission,
  companyId: string
): Promise<boolean> {
  if (!isPermission(permission)) return false;
  const [u] = await dbc
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u || !u.isActive) return false;
  const [link] = await dbc
    .select({ role: userCompanies.role })
    .from(userCompanies)
    .where(
      and(
        eq(userCompanies.userId, userId),
        eq(userCompanies.companyId, companyId),
        eq(userCompanies.isActive, true)
      )
    )
    .limit(1);
  if (!link) return false;
  if (link.role === "OWNER") return true;
  const rows = await dbc
    .select({ permission: userPermissions.permission })
    .from(userPermissions)
    .where(
      and(
        eq(userPermissions.userId, userId),
        eq(userPermissions.companyId, companyId),
        eq(userPermissions.permission, permission)
      )
    )
    .limit(1);
  return rows.length > 0;
}

/** Live role for a user id in one company (null when no active link exists). */
export async function liveUserRole(
  dbc: Db | DbTx,
  userId: string,
  companyId: string
): Promise<string | null> {
  const [u] = await dbc
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!u || !u.isActive) return null;
  const [link] = await dbc
    .select({ role: userCompanies.role })
    .from(userCompanies)
    .where(
      and(
        eq(userCompanies.userId, userId),
        eq(userCompanies.companyId, companyId),
        eq(userCompanies.isActive, true)
      )
    )
    .limit(1);
  return link?.role ?? null;
}
