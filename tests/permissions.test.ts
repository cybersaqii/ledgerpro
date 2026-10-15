import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { hashPassword } from "@/lib/auth";
import * as s from "@/db/schema";
import {
  PERMISSIONS,
  STAFF_DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
  isPermission,
  userHasPermission,
  getUserPermissions,
  setUserPermissions,
  ensureStaffDefaults,
  liveUserRole,
  type Permission,
} from "@/lib/permissions";
import { en } from "@/lib/i18n/en";
import { ur } from "@/lib/i18n/ur";

let db: TestDb;
let cleanup: () => void;

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

async function makeCompany(name: string): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.companies).values({ id, name });
  return id;
}

async function makeUser(companyId: string, email: string, role: "OWNER" | "STAFF", isActive = true): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(s.users).values({
    id, companyId, name: email, email,
    passwordHash: await hashPassword("password123"),
    role, isActive,
  });
  // Multi-company: every test user gets an active membership link, mirroring
  // what signup / add-staff now insert via ensureUserCompanyLink.
  await db.insert(s.userCompanies).values({
    id: crypto.randomUUID(), userId: id, companyId, role, isActive: true,
  });
  return id;
}

describe("permission catalog", () => {
  it("has stable, unique keys", () => {
    expect(PERMISSIONS.length).toBeGreaterThan(10);
    expect(new Set(PERMISSIONS).size).toBe(PERMISSIONS.length);
  });
  it("defaults are a subset of the catalog", () => {
    for (const p of STAFF_DEFAULT_PERMISSIONS) expect(PERMISSIONS).toContain(p);
  });
  it("groups cover every permission exactly once", () => {
    const flat = PERMISSION_GROUPS.flatMap((g) => g.permissions);
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...PERMISSIONS].sort());
  });
  it("isPermission guards unknown keys", () => {
    expect(isPermission("sales")).toBe(true);
    expect(isPermission("hacker")).toBe(false);
    expect(isPermission("")).toBe(false);
    expect(isPermission("SALES")).toBe(false);
  });
});

describe("staff permission grants", () => {
  it("owner bypasses every permission check", async () => {
    const c = await makeCompany("Owner Co");
    const owner = await makeUser(c, "owner@x.com", "OWNER");
    for (const p of PERMISSIONS) {
      expect(await userHasPermission(db, owner, p as Permission, c)).toBe(true);
    }
  });
  it("granted staff permissions pass, others fail", async () => {
    const c = await makeCompany("Staff Co");
    const staff = await makeUser(c, "staff@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    expect(await userHasPermission(db, staff, "sales", c)).toBe(true);
    expect(await userHasPermission(db, staff, "pos", c)).toBe(true);
    expect(await userHasPermission(db, staff, "purchases", c)).toBe(false);
    expect(await userHasPermission(db, staff, "team", c)).toBe(false);
  });
  it("setUserPermissions replaces the grant set and drops unknown keys", async () => {
    const c = await makeCompany("Replace Co");
    const staff = await makeUser(c, "rep@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["reports_basic", "nope"] });
    expect(await getUserPermissions(db, staff, c)).toEqual(["reports_basic"]);
  });
  it("staff with no grant rows gets nothing", async () => {
    const c = await makeCompany("Empty Co");
    const staff = await makeUser(c, "empty@x.com", "STAFF");
    expect(await getUserPermissions(db, staff, c)).toEqual([]);
    expect(await userHasPermission(db, staff, "sales", c)).toBe(false);
  });
  it("inactive users lose every permission immediately (live revocation)", async () => {
    const c = await makeCompany("Inactive Co");
    const staff = await makeUser(c, "gone@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: [...STAFF_DEFAULT_PERMISSIONS] });
    expect(await userHasPermission(db, staff, "sales", c)).toBe(true);
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, staff));
    expect(await userHasPermission(db, staff, "sales", c)).toBe(false);
  });
  it("grants never leak between users", async () => {
    const c = await makeCompany("Leak Co");
    const a = await makeUser(c, "a@x.com", "STAFF");
    const b = await makeUser(c, "b@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: a, permissions: ["sales"] });
    expect(await userHasPermission(db, a, "sales", c)).toBe(true);
    expect(await userHasPermission(db, b, "sales", c)).toBe(false);
  });
  it("setUserPermissions works inside an existing transaction (nested savepoint, API-route pattern)", async () => {
    const c = await makeCompany("Nested Co");
    const staff = await makeUser(c, "nested@x.com", "STAFF");
    await db.transaction(async (tx) => {
      await tx.update(s.users).set({ name: "Nested Staff" }).where(eq(s.users.id, staff));
      await setUserPermissions(tx, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    });
    expect([...(await getUserPermissions(db, staff, c))].sort()).toEqual(["pos", "sales"]);
    expect(await userHasPermission(db, staff, "pos", c)).toBe(true);
  });
  it("nested setUserPermissions rolls back with the outer transaction", async () => {
    const c = await makeCompany("Rollback Co");
    const staff = await makeUser(c, "rollback@x.com", "STAFF");
    await db.transaction(async (tx) => {
      await setUserPermissions(tx, { companyId: c, userId: staff, permissions: ["sales"] });
      throw new Error("boom");
    }).catch(() => {});
    expect(await getUserPermissions(db, staff, c)).toEqual([]);
  });
  it("setUserPermissions refuses users from another company", async () => {
    const c1 = await makeCompany("Iso A");
    const c2 = await makeCompany("Iso B");
    const staff = await makeUser(c1, "iso@x.com", "STAFF");
    await expect(
      setUserPermissions(db, { companyId: c2, userId: staff, permissions: ["sales"] })
    ).rejects.toThrow();
    expect(await userHasPermission(db, staff, "sales", c1)).toBe(false);
  });
  it("ensureStaffDefaults seeds defaults only when no rows exist", async () => {
    const c = await makeCompany("Defaults Co");
    const fresh = await makeUser(c, "fresh@x.com", "STAFF");
    await ensureStaffDefaults(db, { companyId: c, userId: fresh });
    expect([...(await getUserPermissions(db, fresh, c))].sort()).toEqual([...STAFF_DEFAULT_PERMISSIONS].sort());
    // second call is a no-op and never wipes a customized set
    await setUserPermissions(db, { companyId: c, userId: fresh, permissions: ["pos"] });
    await ensureStaffDefaults(db, { companyId: c, userId: fresh });
    expect(await getUserPermissions(db, fresh, c)).toEqual(["pos"]);
  });
  it("liveUserRole reflects the current membership role per company", async () => {    const c = await makeCompany("Role Co");
    const u = await makeUser(c, "role@x.com", "STAFF");
    expect(await liveUserRole(db, u, c)).toBe("STAFF");
    // Promoting the membership row (not users.role) flips the live role.
    await db
      .update(s.userCompanies)
      .set({ role: "OWNER" })
      .where(and(eq(s.userCompanies.userId, u), eq(s.userCompanies.companyId, c)));
    expect(await liveUserRole(db, u, c)).toBe("OWNER");
    expect(await liveUserRole(db, "no-such-user", c)).toBeNull();
    // A user with no link in another company has no role there.
    const c2 = await makeCompany("Role Co 2");
    expect(await liveUserRole(db, u, c2)).toBeNull();
  });
});

describe("multi-company permission scoping (migration 0057)", () => {
  async function linkUser(userId: string, companyId: string, role: "OWNER" | "STAFF") {
    await db.insert(s.userCompanies).values({
      id: crypto.randomUUID(), userId, companyId, role, isActive: true,
    });
  }

  it("grants never leak between companies", async () => {
    const c1 = await makeCompany("Scope A");
    const c2 = await makeCompany("Scope B");
    const staff = await makeUser(c1, "scope@x.com", "STAFF");
    await linkUser(staff, c2, "STAFF");
    await setUserPermissions(db, { companyId: c1, userId: staff, permissions: ["sales"] });
    expect(await userHasPermission(db, staff, "sales", c1)).toBe(true);
    expect(await userHasPermission(db, staff, "sales", c2)).toBe(false);
    expect(await getUserPermissions(db, staff, c2)).toEqual([]);
  });

  it("OWNER of company A is not OWNER in company B", async () => {
    const c1 = await makeCompany("Own A");
    const c2 = await makeCompany("Own B");
    const owner = await makeUser(c1, "owner2@x.com", "OWNER");
    await linkUser(owner, c2, "STAFF");
    // Full bypass in their own company...
    for (const p of PERMISSIONS) {
      expect(await userHasPermission(db, owner, p as Permission, c1)).toBe(true);
    }
    // ...but nothing in the other company without grants.
    expect(await userHasPermission(db, owner, "sales", c2)).toBe(false);
    expect(await liveUserRole(db, owner, c1)).toBe("OWNER");
    expect(await liveUserRole(db, owner, c2)).toBe("STAFF");
  });

  it("setUserPermissions delete is company-scoped", async () => {
    const c1 = await makeCompany("Del A");
    const c2 = await makeCompany("Del B");
    const staff = await makeUser(c1, "del@x.com", "STAFF");
    await linkUser(staff, c2, "STAFF");
    await setUserPermissions(db, { companyId: c1, userId: staff, permissions: ["sales", "pos"] });
    await setUserPermissions(db, { companyId: c2, userId: staff, permissions: ["reports_basic"] });
    // Replacing the set in c2 must not wipe c1's grants.
    expect([...(await getUserPermissions(db, staff, c1))].sort()).toEqual(["pos", "sales"]);
    expect(await getUserPermissions(db, staff, c2)).toEqual(["reports_basic"]);
  });

  it("ensureStaffDefaults seeds per company", async () => {
    const c1 = await makeCompany("Def A");
    const c2 = await makeCompany("Def B");
    const staff = await makeUser(c1, "def@x.com", "STAFF");
    await linkUser(staff, c2, "STAFF");
    await setUserPermissions(db, { companyId: c1, userId: staff, permissions: ["pos"] });
    // Grants exist in c1, but c2 still gets seeded defaults.
    expect(await ensureStaffDefaults(db, { companyId: c2, userId: staff })).toBe(true);
    expect([...(await getUserPermissions(db, staff, c2))].sort()).toEqual(
      [...STAFF_DEFAULT_PERMISSIONS].sort()
    );
    expect(await getUserPermissions(db, staff, c1)).toEqual(["pos"]);
  });

  it("ensureUserCompanyLink inserts once and never duplicates", async () => {
    const { ensureUserCompanyLink } = await import("@/lib/auth");
    const c = await makeCompany("Link Co");
    const u = await makeUser(c, "link@x.com", "STAFF");
    // makeUser already linked; ensure must be a no-op.
    await ensureUserCompanyLink(db, { userId: u, companyId: c, role: "STAFF" });
    const rows = await db
      .select({ id: s.userCompanies.id })
      .from(s.userCompanies)
      .where(and(eq(s.userCompanies.userId, u), eq(s.userCompanies.companyId, c)));
    expect(rows.length).toBe(1);
    // A fresh user with no link gets exactly one row.
    const u2 = crypto.randomUUID();
    await db.insert(s.users).values({
      id: u2, companyId: c, name: "nolink", email: "nolink@x.com",
      passwordHash: await hashPassword("password123"), role: "STAFF", isActive: true,
    });
    await ensureUserCompanyLink(db, { userId: u2, companyId: c, role: "STAFF" });
    await ensureUserCompanyLink(db, { userId: u2, companyId: c, role: "STAFF" });
    const rows2 = await db
      .select({ id: s.userCompanies.id })
      .from(s.userCompanies)
      .where(and(eq(s.userCompanies.userId, u2), eq(s.userCompanies.companyId, c)));
    expect(rows2.length).toBe(1);
    // The new link unblocks permission checks for that company.
    expect(await liveUserRole(db, u2, c)).toBe("STAFF");
  });
});

describe("permission i18n parity (en/ur)", () => {
  function leaves(obj: unknown, prefix = ""): string[] {
    if (typeof obj === "string") return [prefix];
    if (obj && typeof obj === "object") {
      return Object.entries(obj).flatMap(([k, v]) => leaves(v, prefix ? `${prefix}.${k}` : k));
    }
    return [];
  }
  it("perms + settingsteam keys match exactly", () => {
    const enKeys = new Set(leaves((en as Record<string, unknown>).perms).concat(leaves((en as Record<string, unknown>).settingsteam)));
    const urKeys = new Set(leaves((ur as Record<string, unknown>).perms).concat(leaves((ur as Record<string, unknown>).settingsteam)));
    const missing = [...enKeys].filter((k) => !urKeys.has(k));
    const extra = [...urKeys].filter((k) => !enKeys.has(k));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
  it("every catalog permission has label + description keys in both languages", () => {
    for (const p of PERMISSIONS) {
      for (const dict of [en, ur]) {
        const perms = (dict as Record<string, Record<string, string>>).perms;
        expect(typeof perms[p], `${p} label`).toBe("string");
        expect(typeof perms[`${p}Desc`], `${p} description`).toBe("string");
      }
    }
  });
});
