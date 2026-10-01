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
  // Module 6: approve/reject staged documents (amount-threshold workflows).
  // Kept out of the staff defaults: approval power is explicitly granted.
  "approvals",
  // Module 8: payroll & HRM (employees, runs, advances, disbursement).
  // Kept out of the staff defaults: salary data is owner-granted only.
  "payroll",
  // Module 9: fixed assets (register, depreciation runs, sale/disposal).
  // Kept out of the staff defaults: asset movements are owner-granted.
  "assets",
  // Module 11: customer & supplier portals (issue/revoke portal tokens,
  // approve order requests, reconcile payment intents).
  // Kept out of the staff defaults: portal links expose party data externally.
  "portal",
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
  "documents",
  "reports_basic",
  "held_bills",
];

/** UI grouping for the team permission editor (i18n keys: perms.group.<key>). */
export const PERMISSION_GROUPS: { key: string; permissions: Permission[] }[] = [
  { key: "daily", permissions: ["sales", "purchases", "pos", "payments", "expenses", "held_bills"] },
  { key: "masters", permissions: ["parties", "products", "stock", "documents"] },
  { key: "insights", permissions: ["reports_basic", "reports_accounting", "audit"] },
  { key: "admin", permissions: ["settings", "team", "import_export", "backups", "period_lock", "approvals", "portal"] },
  // Module 8: payroll & HRM stands alone — salary data is sensitive.
  { key: "hr", permissions: ["payroll"] },
  // Module 9: fixed assets stands alone — asset movements are sensitive.
  { key: "assets", permissions: ["assets"] },
];

/** Label/description i18n keys for a permission: perms.<key>, perms.<key>Desc. */
export function permissionLabelKey(p: Permission): string {
  return `perms.${p}`;
}
export function permissionDescKey(p: Permission): string {
  return `perms.${p}Desc`;
}
