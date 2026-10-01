/**
 * W4 QA-fix validation tests (items 6, 7, 10).
 *
 * 6:  negative product prices → 422 on POST /api/products and PATCH /api/products/[id]
 *     (zod priceStr); inline form error is UI-only (covered by tsc + inspection).
 * 7:  PATCH /api/bank-accounts/[id] {isActive} — clean account deactivates (200),
 *     account with a payment is blocked (409), reactivation works.
 * 10: validateImageUrl rejects 0.0.0.0 / :: / ::1 / [::] / [::1]; localhost still blocked.
 *
 * Item 12 (forgot-password resend label) is UI-only: verified by code inspection + tsc.
 */
import { ROUTES_DB_URL } from "./qa-routes-env";
import { describe, it, expect, beforeAll, vi } from "vitest";
import { eq, and } from "drizzle-orm";
import { createClient } from "@libsql/client";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateImageUrl, ImageUrlError } from "@/lib/product-image";
import { productSchema } from "@/lib/validators";
import { setupCompany, addBankAccount } from "@/lib/setup";
import type { TestDb } from "./helpers";
import * as s from "@/db/schema";

const hoisted = vi.hoisted(() => ({
  cid: crypto.randomUUID(),
  uid: crypto.randomUUID(),
}));

vi.mock("@/lib/route-helpers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/route-helpers")>();
  const dbm = await import("@/lib/db");
  return {
    ...actual,
    db: dbm.db,
    requirePermission: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Tester" },
      companyId: hoisted.cid,
    }),
    requireCompany: async () => ({
      ok: true as const,
      session: { uid: hoisted.uid, name: "QA Tester", cid: hoisted.cid },
      companyId: hoisted.cid,
      response: null,
    }),
  };
});

async function migrateFileDb(url: string): Promise<void> {
  const client = createClient({ url });
  try {
    const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((line) => {
          const idx = line.indexOf("--");
          return idx >= 0 ? line.slice(0, idx) : line;
        })
        .join("\n");
      for (const stmt of text.split(";").map((x) => x.trim()).filter((x) => x.length > 0)) {
        await client.execute(stmt);
      }
    }
  } finally {
    client.close();
  }
}

describe("W4 item 6 — negative product prices rejected", () => {
  it("productSchema rejects negative purchasePrice / salePrice / minSalePrice", () => {
    const base = { sku: "T-1", name: "Test item" };
    expect(productSchema.safeParse({ ...base, purchasePrice: "-5" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, salePrice: "-0.01" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, minSalePrice: "-100" }).success).toBe(false);
    expect(productSchema.safeParse({ ...base, purchasePrice: "0", salePrice: "12.50" }).success).toBe(true);
  });

  it("POST /api/products with a negative price → 422", async () => {
    const { NextRequest } = await import("next/server");
    const productsRoute = await import("@/app/api/products/route");
    const req = new NextRequest("http://x/api/products", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sku: "NEG-1", name: "Neg price", purchasePrice: "-5", salePrice: "10" }),
    });
    const res = await productsRoute.POST(req);
    expect(res.status).toBe(422);
  });
});

describe("W4 item 7 — bank-account deactivate guard", () => {
  let routeDb: TestDb;
  let productsIdRoute: typeof import("@/app/api/products/[id]/route");
  let bankAcctRoute: typeof import("@/app/api/bank-accounts/[id]/route");
  let banksRoute: typeof import("@/app/api/banks/route");
  let branchId: string;
  let cleanBankId: string;
  let busyBankId: string;

  async function reqJson(url: string, method: string, body: unknown) {
    const { NextRequest } = await import("next/server");
    return new NextRequest(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    await migrateFileDb(ROUTES_DB_URL);
    const dbm = await import("@/lib/db");
    routeDb = dbm.db;
    productsIdRoute = await import("@/app/api/products/[id]/route");
    bankAcctRoute = await import("@/app/api/bank-accounts/[id]/route");
    banksRoute = await import("@/app/api/banks/route");

    await routeDb.insert(s.companies).values({ id: hoisted.cid, name: "QA Co", businessType: "WHOLESALE" });
    ({ branchId } = await setupCompany(routeDb, hoisted.cid));

    // clean account: no transactions
    const clean = await addBankAccount(routeDb, hoisted.cid, { name: "Clean Bank", kind: "BANK", openingBalance: 0n });
    cleanBankId = clean.id;
    // busy account: one payment references it
    const busy = await addBankAccount(routeDb, hoisted.cid, { name: "Busy Bank", kind: "BANK", openingBalance: 0n });
    busyBankId = busy.id;
    await routeDb.insert(s.payments).values({
      id: crypto.randomUUID(),
      companyId: hoisted.cid,
      branchId,
      kind: "RECEIPT",
      date: new Date(),
      bankAccountId: busyBankId,
      amount: 50000n,
      method: "CASH",
      createdById: hoisted.uid,
    });
  }, 60000);

  it("PATCH /api/products/[id] with a negative salePrice → 422", async () => {
    const pid = crypto.randomUUID();
    await routeDb.insert(s.products).values({
      id: pid, companyId: hoisted.cid, sku: "PATCHNEG", name: "Patch neg",
      unit: "PCS", purchasePrice: 100n, salePrice: 150n, taxBps: 0, trackStock: true,
      reorderLevel: 0n, minSalePrice: 0n,
    });
    const req = await reqJson(`http://x/api/products/${pid}`, "PATCH", { salePrice: "-10" });
    const res = await productsIdRoute.PATCH(req, { params: Promise.resolve({ id: pid }) });
    expect(res.status).toBe(422);
  });

  it("deactivating a clean account → 200 and it disappears from /api/banks", async () => {
    const req = await reqJson(`http://x/api/bank-accounts/${cleanBankId}`, "PATCH", { isActive: false });
    const res = await bankAcctRoute.PATCH(req, { params: Promise.resolve({ id: cleanBankId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isActive: boolean } };
    expect(body.data.isActive).toBe(false);

    const { NextRequest } = await import("next/server");
    const listRes = await banksRoute.GET(new NextRequest("http://x/api/banks"));
    const list = (await listRes.json()) as { data: { id: string }[] };
    expect(list.data.some((b) => b.id === cleanBankId)).toBe(false);
    const allRes = await banksRoute.GET(new NextRequest("http://x/api/banks?all=1"));
    const all = (await allRes.json()) as { data: { id: string; isActive: boolean }[] };
    const row = all.data.find((b) => b.id === cleanBankId);
    expect(row?.isActive).toBe(false);
  });

  it("reactivating the account → 200", async () => {
    const req = await reqJson(`http://x/api/bank-accounts/${cleanBankId}`, "PATCH", { isActive: true });
    const res = await bankAcctRoute.PATCH(req, { params: Promise.resolve({ id: cleanBankId }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { isActive: boolean } };
    expect(body.data.isActive).toBe(true);
  });

  it("deactivating an account with a payment → 409 and it stays active", async () => {
    const req = await reqJson(`http://x/api/bank-accounts/${busyBankId}`, "PATCH", { isActive: false });
    const res = await bankAcctRoute.PATCH(req, { params: Promise.resolve({ id: busyBankId }) });
    expect(res.status).toBe(409);
    const rows = await routeDb
      .select({ a: s.bankAccounts.isActive })
      .from(s.bankAccounts)
      .where(and(eq(s.bankAccounts.id, busyBankId), eq(s.bankAccounts.companyId, hoisted.cid)))
      .limit(1);
    expect(rows[0].a).toBe(true);
  });
});

describe("W4 item 10 — image URL blocklist (wildcard + IPv6 loopback)", () => {
  it("rejects 0.0.0.0", () => {
    expect(() => validateImageUrl("https://0.0.0.0/a.jpg")).toThrow(ImageUrlError);
  });
  it("rejects :: and ::1 (bracketed forms)", () => {
    expect(() => validateImageUrl("https://[::]/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://[::1]/a.jpg")).toThrow(ImageUrlError);
  });
  it("still rejects localhost and private ranges", () => {
    expect(() => validateImageUrl("https://localhost/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://localhost./a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://127.0.0.1/a.jpg")).toThrow(ImageUrlError);
    expect(() => validateImageUrl("https://10.1.2.3/a.jpg")).toThrow(ImageUrlError);
  });
  it("still accepts a public https URL", () => {
    expect(validateImageUrl("https://example.com/img/photo.jpg")).toBe("https://example.com/img/photo.jpg");
  });
});
