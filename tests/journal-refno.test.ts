/**
 * Phase 3 — journal Ref No.: an optional user reference on a manual journal
 * voucher (e.g. a bank slip no.). Blank keeps the voucher number as the
 * reference, exactly as before.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDb } from "./helpers";
import { setupCompany, SYS, accountMap } from "@/lib/setup";
import { postManualJournal } from "@/lib/journal-vouchers";
import * as s from "@/db/schema";

let db: TestDb;
let cleanup: () => void;
const userId = crypto.randomUUID();

async function newCompany() {
  const companyId = crypto.randomUUID();
  await db.insert(s.companies).values({ id: companyId, name: "JV Ref Test Co" });
  const { branchId } = await setupCompany(db, companyId);
  const ac = await db.transaction((tx) => accountMap(tx, companyId));
  return { companyId, branchId, ac };
}

beforeAll(async () => {
  ({ db, cleanup } = await createTestDb());
});

afterAll(() => cleanup());

describe("journal Ref No.", () => {
  it("stores a user reference on the journal entry", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const { entryId, docNo } = await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId,
        branchId,
        date: new Date("2026-11-20T00:00:00Z"),
        memo: "Bank slip adjustment",
        reference: "SLIP-2026-8841",
        lines: [
          { accountId: ac[SYS.CASH], debit: 50000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 50000n },
        ],
        createdById: userId,
      })
    );
    const [entry] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, entryId)).limit(1);
    expect(entry.docNo).toBe(docNo);
    expect(entry.reference).toBe("SLIP-2026-8841");
  });

  it("defaults the reference to the voucher number when blank", async () => {
    const { companyId, branchId, ac } = await newCompany();
    const { entryId, docNo } = await db.transaction((tx) =>
      postManualJournal(tx, {
        companyId,
        branchId,
        date: new Date("2026-11-20T00:00:00Z"),
        memo: "No reference given",
        lines: [
          { accountId: ac[SYS.CASH], debit: 10000n, credit: 0n },
          { accountId: ac[SYS.SALES], debit: 0n, credit: 10000n },
        ],
        createdById: userId,
      })
    );
    const [entry] = await db.select().from(s.journalEntries).where(eq(s.journalEntries.id, entryId)).limit(1);
    expect(entry.reference).toBe(docNo);
  });
});
