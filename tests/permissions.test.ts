import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
      expect(await userHasPermission(db, owner, p as Permission)).toBe(true);
    }
  });
  it("granted staff permissions pass, others fail", async () => {
    const c = await makeCompany("Staff Co");
    const staff = await makeUser(c, "staff@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    expect(await userHasPermission(db, staff, "sales")).toBe(true);
    expect(await userHasPermission(db, staff, "pos")).toBe(true);
    expect(await userHasPermission(db, staff, "purchases")).toBe(false);
    expect(await userHasPermission(db, staff, "team")).toBe(false);
  });
  it("setUserPermissions replaces the grant set and drops unknown keys", async () => {
    const c = await makeCompany("Replace Co");
    const staff = await makeUser(c, "rep@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: ["reports_basic", "nope"] });
    expect(await getUserPermissions(db, staff)).toEqual(["reports_basic"]);
  });
  it("staff with no grant rows gets nothing", async () => {
    const c = await makeCompany("Empty Co");
    const staff = await makeUser(c, "empty@x.com", "STAFF");
    expect(await getUserPermissions(db, staff)).toEqual([]);
    expect(await userHasPermission(db, staff, "sales")).toBe(false);
  });
  it("inactive users lose every permission immediately (live revocation)", async () => {
    const c = await makeCompany("Inactive Co");
    const staff = await makeUser(c, "gone@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: staff, permissions: [...STAFF_DEFAULT_PERMISSIONS] });
    expect(await userHasPermission(db, staff, "sales")).toBe(true);
    await db.update(s.users).set({ isActive: false }).where(eq(s.users.id, staff));
    expect(await userHasPermission(db, staff, "sales")).toBe(false);
  });
  it("grants never leak between users", async () => {
    const c = await makeCompany("Leak Co");
    const a = await makeUser(c, "a@x.com", "STAFF");
    const b = await makeUser(c, "b@x.com", "STAFF");
    await setUserPermissions(db, { companyId: c, userId: a, permissions: ["sales"] });
    expect(await userHasPermission(db, a, "sales")).toBe(true);
    expect(await userHasPermission(db, b, "sales")).toBe(false);
  });
  it("setUserPermissions works inside an existing transaction (nested savepoint, API-route pattern)", async () => {
    const c = await makeCompany("Nested Co");
    const staff = await makeUser(c, "nested@x.com", "STAFF");
    await db.transaction(async (tx) => {
      await tx.update(s.users).set({ name: "Nested Staff" }).where(eq(s.users.id, staff));
      await setUserPermissions(tx, { companyId: c, userId: staff, permissions: ["sales", "pos"] });
    });
    expect([...(await getUserPermissions(db, staff))].sort()).toEqual(["pos", "sales"]);
    expect(await userHasPermission(db, staff, "pos")).toBe(true);
  });
  it("nested setUserPermissions rolls back with the outer transaction", async () => {
    const c = await makeCompany("Rollback Co");
    const staff = await makeUser(c, "rollback@x.com", "STAFF");
    await db.transaction(async (tx) => {
      await setUserPermissions(tx, { companyId: c, userId: staff, permissions: ["sales"] });
      throw new Error("boom");
    }).catch(() => {});
    expect(await getUserPermissions(db, staff)).toEqual([]);
  });
  it("setUserPermissions refuses users from another company", async () => {
    const c1 = await makeCompany("Iso A");
    const c2 = await makeCompany("Iso B");
    const staff = await makeUser(c1, "iso@x.com", "STAFF");
    await expect(
      setUserPermissions(db, { companyId: c2, userId: staff, permissions: ["sales"] })
    ).rejects.toThrow();
    expect(await userHasPermission(db, staff, "sales")).toBe(false);
  });
  it("ensureStaffDefaults seeds defaults only when no rows exist", async () => {
    const c = await makeCompany("Defaults Co");
    const fresh = await makeUser(c, "fresh@x.com", "STAFF");
    await ensureStaffDefaults(db, { companyId: c, userId: fresh });
    expect([...(await getUserPermissions(db, fresh))].sort()).toEqual([...STAFF_DEFAULT_PERMISSIONS].sort());
    // second call is a no-op and never wipes a customized set
    await setUserPermissions(db, { companyId: c, userId: fresh, permissions: ["pos"] });
    await ensureStaffDefaults(db, { companyId: c, userId: fresh });
    expect(await getUserPermissions(db, fresh)).toEqual(["pos"]);
  });
  it("liveUserRole reflects the current DB role", async () => {
    const c = await makeCompany("Role Co");
    const u = await makeUser(c, "role@x.com", "STAFF");
    expect(await liveUserRole(db, u)).toBe("STAFF");
    await db.update(s.users).set({ role: "OWNER" }).where(eq(s.users.id, u));
    expect(await liveUserRole(db, u)).toBe("OWNER");
    expect(await liveUserRole(db, "no-such-user")).toBeNull();
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
