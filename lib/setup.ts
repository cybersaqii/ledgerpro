import { eq, and, desc, not, inArray, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  branches,
  journalEntries,
  journalLines,
  numberSequences,
  settings,
} from "@/db/schema";
import type { Db, DbTx } from "./db";

// System account codes — created for every new company.
export const SYS = {
  CASH: "1001",
  BANK: "1002",
  AR: "1100",
  INVENTORY: "1200",
  INPUT_TAX: "1300",
  PDC_RECEIVABLE: "1310",
  AP: "2001",
  TAX_PAYABLE: "2100",
  PDC_PAYABLE: "2110",
  CAPITAL: "3001",
  OPENING_EQUITY: "3002",
  SALES: "4001",
  SALES_RETURN: "4002",
  DISCOUNT_RECEIVED: "4010",
  COGS: "5001",
  PURCHASES: "5003",
  DISCOUNT_GIVEN: "5010",
  EXPENSES: "6000",
} as const;

const SYSTEM_ACCOUNTS: { code: string; name: string; type: string }[] = [
  { code: SYS.CASH, name: "Cash in Hand", type: "ASSET" },
  { code: SYS.BANK, name: "Bank Account", type: "ASSET" },
  { code: SYS.AR, name: "Accounts Receivable", type: "ASSET" },
  { code: SYS.INVENTORY, name: "Inventory", type: "ASSET" },
  { code: SYS.INPUT_TAX, name: "Input Sales Tax", type: "ASSET" },
  { code: SYS.PDC_RECEIVABLE, name: "PDC Receivable (Cheques in Hand)", type: "ASSET" },
  { code: SYS.AP, name: "Accounts Payable", type: "LIABILITY" },
  { code: SYS.TAX_PAYABLE, name: "Sales Tax Payable", type: "LIABILITY" },
  { code: SYS.PDC_PAYABLE, name: "PDC Payable (Cheques Issued)", type: "LIABILITY" },
  { code: SYS.CAPITAL, name: "Owner's Capital", type: "EQUITY" },
  { code: SYS.OPENING_EQUITY, name: "Opening Balance Equity", type: "EQUITY" },
  { code: SYS.SALES, name: "Sales Revenue", type: "INCOME" },
  { code: SYS.SALES_RETURN, name: "Sales Returns", type: "INCOME" },
  { code: SYS.DISCOUNT_RECEIVED, name: "Discount Received", type: "INCOME" },
  { code: SYS.COGS, name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: SYS.PURCHASES, name: "Purchases (Non-stock)", type: "EXPENSE" },
  { code: SYS.DISCOUNT_GIVEN, name: "Discount Given", type: "EXPENSE" },
  { code: SYS.EXPENSES, name: "General Expenses", type: "EXPENSE" },
];

const DOC_PREFIXES: Record<string, string> = {
  INVOICE: "INV-",
  QUOTATION: "QUO-",
  ORDER: "ORD-",
  CHALLAN: "CHL-",
  RETURN: "SR-",
  BILL: "BIL-",
  GRN: "GRN-",
  PAYMENT: "PAY-",
  RECEIPT: "REC-",
  EXPENSE: "EXP-",
};

/** Next document number, e.g. INV-0001. Must be called inside a transaction. */
export async function nextDocNo(tx: DbTx, companyId: string, docType: string): Promise<string> {
  const prefix = DOC_PREFIXES[docType] ?? `${docType}-`;
  await tx
    .insert(numberSequences)
    .values({ id: crypto.randomUUID(), companyId, docType, prefix, lastNo: 1 })
    .onConflictDoUpdate({
      target: [numberSequences.companyId, numberSequences.docType],
      set: { lastNo: sql`${numberSequences.lastNo} + 1` },
    });
  const rows = await tx
    .select({ lastNo: numberSequences.lastNo })
    .from(numberSequences)
    .where(and(eq(numberSequences.companyId, companyId), eq(numberSequences.docType, docType)));
  const lastNo = rows[0]?.lastNo ?? 1;
  return `${prefix}${String(lastNo).padStart(4, "0")}`;
}

/** Next GL code for a new bank/cash account (1010, 1011, ...). */
async function nextBankCode(tx: DbTx, companyId: string): Promise<string> {
  const rows = await tx
    .select({ code: accounts.code })
    .from(accounts)
    .where(
      and(
        eq(accounts.companyId, companyId),
        sql`${accounts.code} LIKE '10%'`,
        not(inArray(accounts.code, [SYS.CASH, SYS.BANK, SYS.AR]))
      )
    )
    .orderBy(desc(accounts.code))
    .limit(1);
  const n = rows[0] ? parseInt(rows[0].code.slice(2), 10) + 1 : 10;
  return `10${String(n).padStart(2, "0")}`;
}

async function createBankAccount(
  tx: DbTx,
  companyId: string,
  opts: { name: string; kind: string; bankName?: string; accountNo?: string; openingBalance?: bigint }
) {
  const code = await nextBankCode(tx, companyId);
  const glId = crypto.randomUUID();
  await tx.insert(accounts).values({
    id: glId,
    companyId,
    code,
    name: opts.name,
    type: "ASSET",
    isSystem: true,
  });
  const opening = opts.openingBalance ?? 0n;
  const baId = crypto.randomUUID();
  await tx.insert(bankAccounts).values({
    id: baId,
    companyId,
    name: opts.name,
    bankName: opts.bankName,
    accountNo: opts.accountNo,
    kind: opts.kind,
    accountId: glId,
    openingBalance: opening,
    balance: opening,
  });
  return { id: baId, accountId: glId };
}

/** Full company bootstrap: branch, chart of accounts, cash account, sequences, settings.
 *  Idempotent: safe to re-run — only missing pieces are created (also backfills
 *  system accounts added after the company was created). */
export async function setupCompany(db: Db, companyId: string, opts: { defaultBranchName?: string } = {}) {
  return db.transaction(async (tx) => {
    const branchRows = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.companyId, companyId))
      .limit(1);
    let branchId = branchRows[0]?.id;
    if (!branchId) {
      branchId = crypto.randomUUID();
      await tx.insert(branches).values({
        id: branchId,
        companyId,
        name: opts.defaultBranchName ?? "Main Branch",
        isDefault: true,
      });
    }

    const codeRows = await tx
      .select({ code: accounts.code })
      .from(accounts)
      .where(eq(accounts.companyId, companyId));
    const haveCodes = new Set(codeRows.map((r) => r.code));
    const missingAccounts = SYSTEM_ACCOUNTS.filter((a) => !haveCodes.has(a.code));
    if (missingAccounts.length > 0) {
      await tx.insert(accounts).values(
        missingAccounts.map((a) => ({
          id: crypto.randomUUID(),
          companyId,
          code: a.code,
          name: a.name,
          type: a.type,
          isSystem: true,
        }))
      );
    }

    const bankRows = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(eq(bankAccounts.companyId, companyId))
      .limit(1);
    if (!bankRows[0]) {
      await createBankAccount(tx, companyId, { name: "Cash in Hand", kind: "CASH" });
    }

    const seqRows = await tx
      .select({ docType: numberSequences.docType })
      .from(numberSequences)
      .where(eq(numberSequences.companyId, companyId));
    const haveSeq = new Set(seqRows.map((r) => r.docType));
    const missingSeq = Object.entries(DOC_PREFIXES).filter(([docType]) => !haveSeq.has(docType));
    if (missingSeq.length > 0) {
      await tx.insert(numberSequences).values(
        missingSeq.map(([docType, prefix]) => ({
          id: crypto.randomUUID(),
          companyId,
          docType,
          prefix,
          lastNo: 0,
        }))
      );
    }

    const defaults: [string, string][] = [
      ["invoice_prefix", "INV-"],
      ["currency", "PKR"],
      ["tax_default_bps", "0"],
      ["fiscal_year_start", "07-01"],
    ];
    const settingRows = await tx
      .select({ key: settings.key })
      .from(settings)
      .where(eq(settings.companyId, companyId));
    const haveSettings = new Set(settingRows.map((r) => r.key));
    const missingSettings = defaults.filter(([key]) => !haveSettings.has(key));
    if (missingSettings.length > 0) {
      await tx.insert(settings).values(
        missingSettings.map(([key, value]) => ({ id: crypto.randomUUID(), companyId, key, value }))
      );
    }

    return { branchId };
  });
}

/** Get system account id by code (throws if missing — indicates corrupt setup). */
export async function sysAccount(tx: DbTx, companyId: string, code: string): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .limit(1);
  if (!rows[0]) throw new Error(`System account ${code} missing for company`);
  return rows[0].id;
}

/** Code → id map for all company accounts (throws if a system account is missing). */
export async function accountMap(tx: DbTx, companyId: string): Promise<Record<string, string>> {
  const rows = await tx
    .select({ id: accounts.id, code: accounts.code })
    .from(accounts)
    .where(eq(accounts.companyId, companyId));
  const map: Record<string, string> = {};
  for (const r of rows) map[r.code] = r.id;
  for (const code of Object.values(SYS)) {
    if (!map[code]) throw new Error(`System account ${code} missing`);
  }
  return map;
}

/** Create a new bank/cash account (public helper for settings). */
export async function addBankAccount(
  db: Db,
  companyId: string,
  opts: {
    name: string;
    kind: "BANK" | "CASH" | "WALLET";
    bankName?: string;
    accountNo?: string;
    openingBalance?: bigint;
  }
) {
  return db.transaction(async (tx) => {
    const ba = await createBankAccount(tx, companyId, opts);
    const opening = opts.openingBalance ?? 0n;
    if (opening > 0n) {
      const equityId = await sysAccount(tx, companyId, SYS.OPENING_EQUITY);
      const entryId = crypto.randomUUID();
      await tx.insert(journalEntries).values({
        id: entryId,
        companyId,
        date: new Date(),
        memo: `Opening balance — ${opts.name}`,
        source: "OPENING",
        createdById: "system",
      });
      await tx.insert(journalLines).values([
        { id: crypto.randomUUID(), entryId, accountId: ba.accountId, debit: opening, credit: 0n },
        { id: crypto.randomUUID(), entryId, accountId: equityId, debit: 0n, credit: opening },
      ]);
    }
    return ba;
  });
}
