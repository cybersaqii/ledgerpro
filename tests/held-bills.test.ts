import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany } from "@/lib/setup";
import { createHeldBill, listHeldBills, deleteHeldBill } from "@/lib/held";

let db: TestDb;
let cleanup: () => void;
const companyA = crypto.randomUUID();
const companyB = crypto.randomUUID();
const ownerA = crypto.randomUUID();
const staffA = crypto.randomUUID();
const ownerB = crypto.randomUUID();

const lines = [{ productId: null, name: "Test item", qty: "1", rate: "100", discount: "0" }];

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
  await setupCompany(db, companyA);
  await setupCompany(db, companyB);
});

afterAll(() => cleanup());

describe("server-side held bills: ownership + isolation", () => {
  it("staff sees only their own held bills; owner sees all in the company", async () => {
    await createHeldBill(db, { companyId: companyA, userId: staffA, label: "staff bill", lines, discount: "0" });
    await createHeldBill(db, { companyId: companyA, userId: ownerA, label: "owner bill", lines, discount: "0" });

    const staffView = await listHeldBills(db, { companyId: companyA, userId: staffA, role: "STAFF" });
    expect(staffView).toHaveLength(1);
    expect(staffView[0].label).toBe("staff bill");

    const ownerView = await listHeldBills(db, { companyId: companyA, userId: ownerA, role: "OWNER" });
    expect(ownerView).toHaveLength(2);
  });

  it("a staff member cannot delete another user's held bill; owner can", async () => {
    const id = await createHeldBill(db, { companyId: companyA, userId: ownerA, label: "x", lines, discount: "0" });
    expect(await deleteHeldBill(db, { companyId: companyA, userId: staffA, role: "STAFF", id })).toBe(false);
    expect(await deleteHeldBill(db, { companyId: companyA, userId: ownerA, role: "OWNER", id })).toBe(true);
    expect(await deleteHeldBill(db, { companyId: companyA, userId: ownerA, role: "OWNER", id })).toBe(false); // gone
  });

  it("held bills are invisible across companies", async () => {
    const id = await createHeldBill(db, { companyId: companyA, userId: staffA, label: "A bill", lines, discount: "0" });
    // company B's owner sees nothing from company A…
    const bView = await listHeldBills(db, { companyId: companyB, userId: ownerB, role: "OWNER" });
    expect(bView.find((b) => b.id === id)).toBeUndefined();
    // …and cannot delete it.
    expect(await deleteHeldBill(db, { companyId: companyB, userId: ownerB, role: "OWNER", id })).toBe(false);
  });

  it("deleting a nonexistent held bill returns false", async () => {
    expect(
      await deleteHeldBill(db, { companyId: companyA, userId: ownerA, role: "OWNER", id: "nope" })
    ).toBe(false);
  });
});
