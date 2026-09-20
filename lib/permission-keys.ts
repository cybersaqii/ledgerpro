// Permission keys + metadata shared between server and client.
// Client-safe: no imports, no DB access. Server logic lives in lib/permissions.ts.

/** Every permission key the product understands. Stable strings — stored in the DB. */
export const PERMISSIONS = [
  "sales",
  "purchases",
  "pos",
  "payments",
  "expenses",
  "parties",
  "products",
  "stock",
  "price_lists",
  "documents",
  "reports_basic",
  "reports_accounting",
  "held_bills",
  "settings",
  "team",
  "import_export",
  "backups",
  "period_lock",
  "audit",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const PERMISSION_SET: ReadonlySet<string> = new Set(PERMISSIONS);

export function isPermission(p: string): p is Permission {
  return PERMISSION_SET.has(p);
}

/**
 * What a staff member could already do before granular permissions existed.
 * Backfilled for every existing STAFF user by migration 0015 and assigned to
 * every newly added staff member. Keeps the upgrade behavior-neutral.
 */
export const STAFF_DEFAULT_PERMISSIONS: readonly Permission[] = [
  "sales",
  "purchases",
  "pos",
  "payments",
  "expenses",
  "parties",
  "products",
  "stock",
  "price_lists",
  "documents",
  "reports_basic",
  "held_bills",
];

/** UI grouping for the team permission editor (i18n keys: perms.group.<key>). */
export const PERMISSION_GROUPS: { key: string; permissions: Permission[] }[] = [
  { key: "daily", permissions: ["sales", "purchases", "pos", "payments", "expenses", "held_bills"] },
  { key: "masters", permissions: ["parties", "products", "stock", "price_lists", "documents"] },
  { key: "insights", permissions: ["reports_basic", "reports_accounting", "audit"] },
  { key: "admin", permissions: ["settings", "team", "import_export", "backups", "period_lock"] },
];

/** Label/description i18n keys for a permission: perms.<key>, perms.<key>Desc. */
export function permissionLabelKey(p: Permission): string {
  return `perms.${p}`;
}
export function permissionDescKey(p: Permission): string {
  return `perms.${p}Desc`;
}
