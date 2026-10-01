import { eq, and, desc, not, inArray, sql } from "drizzle-orm";
import {
  accounts,
  bankAccounts,
  branches,
  currencies,
  journalEntries,
  journalLines,
  numberSequences,
  settings,
} from "@/db/schema";
import type { Db, DbTx } from "./db";
import { DEFAULT_CURRENCIES } from "./fx";

// System account codes — created for every new company.
export const SYS = {
  CASH: "1001",
  BANK: "1002",
  AR: "1100",
  INVENTORY: "1200",
  INPUT_TAX: "1300",
  PDC_RECEIVABLE: "1310",
  ADVANCE_SUPPLIERS: "1110", // Module 2: Advance to Suppliers (unallocated vendor payments)
  AP: "2001",
  GRNI_ACCRUAL: "2002", // Module 2: Goods Received Not Invoiced
  TAX_PAYABLE: "2100",
  PDC_PAYABLE: "2110",
  CAPITAL: "3001",
  OPENING_EQUITY: "3002",
  RETAINED_EARNINGS: "3003", // Module 5: year-end close destination (net profit/loss)
  SALES: "4001",
  SALES_RETURN: "4002",
  FREIGHT_INCOME: "4020",
  DISCOUNT_RECEIVED: "4010",
  COGS: "5001",
  PURCHASES: "5003",
  DISCOUNT_GIVEN: "5010",
  EXPENSES: "6000",
  BANK_CHARGES: "6010", // Module 3: bank charges / transfer fees
  INTEREST_INCOME: "4030", // Module 3: interest credited by the bank
  ADJUSTMENT_GAIN: "4040", // Module 4: inventory adjustment gain (stock found)
  SHRINKAGE: "6020", // Module 4: shrinkage expense (damaged / lost stock)
  EMPLOYEE_ADVANCES: "1130", // Module 8: advances/loans to employees (asset)
  SALARIES_PAYABLE: "2119", // Module 8: net salaries payable to staff
  SALARY_TAX_PAYABLE: "2120", // Module 8: withheld salary income tax
  EOBI_PAYABLE: "2121", // Module 8: EOBI / social security payable
  PF_PAYABLE: "2122", // Module 8: provident fund payable
  SALARIES_WAGES_EXPENSE: "6011", // Module 8: gross salaries & wages
  EMPLOYER_CONTRIB_EXPENSE: "6012", // Module 8: employer EOBI/PF contributions
  DEPRECIATION_EXPENSE: "6013", // Module 9: fixed-asset depreciation
  ACCUM_DEPRECIATION: "1400", // Module 9: Accumulated Depreciation (contra-asset; credit balance nets 14xx cost)
  GAIN_ON_DISPOSAL: "4110", // Module 9: gain on sale/scrapping of fixed assets
  LOSS_ON_DISPOSAL: "6030", // Module 9: loss on sale/scrapping of fixed assets
  EXCHANGE_GAIN: "4120", // Module 10: FX gain on settlement of foreign-currency docs
  EXCHANGE_LOSS: "6040", // Module 10: FX loss on settlement of foreign-currency docs
  WIP: "1250", // Module 12: Work-in-Progress Inventory (asset; components issued, awaiting completion)
  MFG_LABOR_PAYABLE: "2123", // Module 12: Manufacturing Labor Payable (dedicated — keeps payroll's 2119 reconciliation clean)
  MFG_OVERHEAD: "6050", // Module 12: Manufacturing Overhead (expense; credited "absorbed" at completion)
} as const;

const SYSTEM_ACCOUNTS: { code: string; name: string; type: string }[] = [
  { code: SYS.CASH, name: "Cash in Hand", type: "ASSET" },
  { code: SYS.BANK, name: "Bank Account", type: "ASSET" },
  { code: SYS.AR, name: "Accounts Receivable", type: "ASSET" },
  { code: SYS.INVENTORY, name: "Inventory", type: "ASSET" },
  { code: SYS.INPUT_TAX, name: "Input Sales Tax", type: "ASSET" },
  { code: SYS.PDC_RECEIVABLE, name: "PDC Receivable (Cheques in Hand)", type: "ASSET" },
  { code: SYS.ADVANCE_SUPPLIERS, name: "Advance to Suppliers", type: "ASSET" },
  { code: SYS.AP, name: "Accounts Payable", type: "LIABILITY" },
  { code: SYS.GRNI_ACCRUAL, name: "Goods Received Not Invoiced", type: "LIABILITY" },
  { code: SYS.TAX_PAYABLE, name: "Sales Tax Payable", type: "LIABILITY" },
  { code: SYS.PDC_PAYABLE, name: "PDC Payable (Cheques Issued)", type: "LIABILITY" },
  { code: SYS.CAPITAL, name: "Owner's Capital", type: "EQUITY" },
  { code: SYS.OPENING_EQUITY, name: "Opening Balance Equity", type: "EQUITY" },
  { code: SYS.RETAINED_EARNINGS, name: "Retained Earnings", type: "EQUITY" },
  { code: SYS.SALES, name: "Sales Revenue", type: "INCOME" },
  { code: SYS.SALES_RETURN, name: "Sales Returns", type: "INCOME" },
  { code: SYS.FREIGHT_INCOME, name: "Freight Income", type: "INCOME" },
  { code: SYS.DISCOUNT_RECEIVED, name: "Discount Received", type: "INCOME" },
  { code: SYS.COGS, name: "Cost of Goods Sold", type: "EXPENSE" },
  { code: SYS.PURCHASES, name: "Purchases (Non-stock)", type: "EXPENSE" },
  { code: SYS.DISCOUNT_GIVEN, name: "Discount Given", type: "EXPENSE" },
  { code: SYS.EXPENSES, name: "General Expenses", type: "EXPENSE" },
  { code: SYS.BANK_CHARGES, name: "Bank Charges", type: "EXPENSE" },
  { code: SYS.INTEREST_INCOME, name: "Interest Income", type: "INCOME" },
  { code: SYS.ADJUSTMENT_GAIN, name: "Inventory Adjustment Gain", type: "INCOME" },
  { code: SYS.SHRINKAGE, name: "Shrinkage Expense", type: "EXPENSE" },
  { code: SYS.EMPLOYEE_ADVANCES, name: "Employee Advances", type: "ASSET" },
  { code: SYS.SALARIES_PAYABLE, name: "Salaries Payable", type: "LIABILITY" },
  { code: SYS.SALARY_TAX_PAYABLE, name: "Salary Withholding Tax Payable", type: "LIABILITY" },
  { code: SYS.EOBI_PAYABLE, name: "EOBI / Social Security Payable", type: "LIABILITY" },
  { code: SYS.PF_PAYABLE, name: "Provident Fund Payable", type: "LIABILITY" },
  { code: SYS.SALARIES_WAGES_EXPENSE, name: "Salaries & Wages Expense", type: "EXPENSE" },
  { code: SYS.EMPLOYER_CONTRIB_EXPENSE, name: "Employer Contribution Expense", type: "EXPENSE" },
  { code: SYS.DEPRECIATION_EXPENSE, name: "Depreciation Expense", type: "EXPENSE" },
  { code: SYS.ACCUM_DEPRECIATION, name: "Accumulated Depreciation", type: "ASSET" },
  { code: SYS.GAIN_ON_DISPOSAL, name: "Gain on Disposal of Fixed Assets", type: "INCOME" },
  { code: SYS.LOSS_ON_DISPOSAL, name: "Loss on Disposal of Fixed Assets", type: "EXPENSE" },
  { code: SYS.EXCHANGE_GAIN, name: "Exchange Gain", type: "INCOME" },
  { code: SYS.EXCHANGE_LOSS, name: "Exchange Loss", type: "EXPENSE" },
  { code: SYS.WIP, name: "Work-in-Progress Inventory", type: "ASSET" },
  { code: SYS.MFG_LABOR_PAYABLE, name: "Manufacturing Labor Payable", type: "LIABILITY" },
  { code: SYS.MFG_OVERHEAD, name: "Manufacturing Overhead", type: "EXPENSE" },
];

const DOC_PREFIXES: Record<string, string> = {
  INVOICE: "INV-",
  QUOTATION: "QUO-",
  ORDER: "ORD-",
  CHALLAN: "CHL-",
  // Legacy shared return sequence (pre-split). Existing SR- purchase returns
  // keep their numbers; new code must use SALE_RETURN / PURCHASE_RETURN.
  RETURN: "SR-",
  SALE_RETURN: "SR-",
  PURCHASE_RETURN: "PR-",
  BILL: "BIL-",
  GRN: "GRN-",
  PAYMENT: "PAY-",
  RECEIPT: "REC-",
  EXPENSE: "EXP-",
  TRANSFER: "TRF-",
  STOCK_TRANSFER: "STR-", // Module 4: stock transfer documents (Draft → In-Transit → Received)
  SUNDRY_RECEIPT: "SRC-", // Module 3: direct (non-invoiced) receipts
  BANK_ADJUSTMENT: "BADJ-", // Module 3: bank charges / interest adjustments
  STOCK_ADJUSTMENT: "ADJ-",
  WORK_ORDER: "MWO-", // Module 12: manufacturing work orders (MWO- avoids WRITE_OFF's WO-)
  PROJECT: "PRJ-", // Module 13: project codes (PRJ-0001, unique per company)
  WRITE_OFF: "WO-",
  CREDIT_NOTE: "CN-",
  DEBIT_NOTE: "DN-",
  PAYROLL_RUN: "PR-", // Module 8: monthly payroll runs (PR-YYYYMM-0001)
  EMPLOYEE_ADVANCE: "ADV-", // Module 8: employee advance issuance
  DEPRECIATION_RUN: "DEP-", // Module 9: monthly depreciation runs (DEP-YYYYMM-0001)
};

/** Next document number, e.g. INV-0001. Must be called inside a transaction.
 *  Pass `prefix` to override the static DOC_PREFIXES mapping — used for
 *  yearly sequences like JV-2026-0001 (docType JOURNAL_VOUCHER_2026). */
export async function nextDocNo(
  tx: DbTx,
  companyId: string,
  docType: string,
  prefix?: string
): Promise<string> {
  const pfx = prefix ?? DOC_PREFIXES[docType] ?? `${docType}-`;
  await tx
    .insert(numberSequences)
    .values({ id: crypto.randomUUID(), companyId, docType, prefix: pfx, lastNo: 1 })
    .onConflictDoUpdate({
      target: [numberSequences.companyId, numberSequences.docType],
      set: { lastNo: sql`${numberSequences.lastNo} + 1` },
    });
  const rows = await tx
    .select({ lastNo: numberSequences.lastNo })
    .from(numberSequences)
    .where(and(eq(numberSequences.companyId, companyId), eq(numberSequences.docType, docType)));
  const lastNo = rows[0]?.lastNo ?? 1;
  return `${pfx}${String(lastNo).padStart(4, "0")}`;
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

/** Account types for bank/cash accounts (Module 3). */
export const BANK_ACCOUNT_TYPES = ["CURRENT", "SAVINGS", "OVERDRAFT", "PETTY_CASH"] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];

/** Branch location types (Module 4): branches are the stock locations, so a
 *  branch can be labelled as a warehouse, shop, van or other location. */
export const BRANCH_LOCATION_TYPES = ["WAREHOUSE", "SHOP", "VAN", "OTHER"] as const;
export type BranchLocationType = (typeof BRANCH_LOCATION_TYPES)[number];

/** Product item types (Module 4): INVENTORY = stock-tracked, NON_INVENTORY =
 *  purchased/sold but not stocked (expensed via Purchases 5003), SERVICE =
 *  never stocked. */
export const PRODUCT_ITEM_TYPES = ["INVENTORY", "NON_INVENTORY", "SERVICE"] as const;
export type ProductItemType = (typeof PRODUCT_ITEM_TYPES)[number];

async function createBankAccount(
  tx: DbTx,
  companyId: string,
  opts: {
    name: string;
    kind: string;
    bankName?: string;
    accountNo?: string;
    iban?: string;
    accountType?: string;
    openingBalance?: bigint;
  }
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
    iban: opts.iban,
    kind: opts.kind,
    accountType: opts.accountType ?? "CURRENT",
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

    // Module 10: seed the default currency set (PKR base + USD/AED/EUR/GBP/
    // SAR/CNY). Idempotent — only missing codes are inserted.
    const curRows = await tx
      .select({ code: currencies.code })
      .from(currencies)
      .where(eq(currencies.companyId, companyId));
    const haveCur = new Set(curRows.map((r) => r.code));
    const missingCur = DEFAULT_CURRENCIES.filter((c) => !haveCur.has(c.code));
    if (missingCur.length > 0) {
      await tx.insert(currencies).values(
        missingCur.map((c) => ({
          id: crypto.randomUUID(),
          companyId,
          code: c.code,
          name: c.name,
          symbol: c.symbol,
          minorUnits: c.minorUnits,
          isBase: c.isBase ? 1 : 0,
          isActive: 1,
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
      // SALE_RETURN continues the legacy shared RETURN sequence: old SR-
      // numbers (both sale and purchase returns drew from it) are the high-
      // water mark, so new SR- numbers can never collide with them.
      // PURCHASE_RETURN starts fresh — the PR- prefix never existed before.
      let legacyReturnLastNo = 0;
      if (missingSeq.some(([docType]) => docType === "SALE_RETURN")) {
        const legacy = await tx
          .select({ lastNo: numberSequences.lastNo })
          .from(numberSequences)
          .where(and(eq(numberSequences.companyId, companyId), eq(numberSequences.docType, "RETURN")))
          .limit(1);
        legacyReturnLastNo = legacy[0]?.lastNo ?? 0;
      }
      await tx.insert(numberSequences).values(
        missingSeq.map(([docType, prefix]) => ({
          id: crypto.randomUUID(),
          companyId,
          docType,
          prefix,
          lastNo: docType === "SALE_RETURN" ? legacyReturnLastNo : 0,
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
export async function sysAccount(tx: Db | DbTx, companyId: string, code: string): Promise<string> {
  const rows = await tx
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
    .limit(1);
  if (!rows[0]) throw new Error(`System account ${code} missing for company`);
  return rows[0].id;
}

/** Code → id map for all company accounts (throws if a system account is missing). */
export async function accountMap(tx: Db | DbTx, companyId: string): Promise<Record<string, string>> {
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
    iban?: string;
    accountType?: string;
    openingBalance?: bigint;
  }
) {
  return db.transaction(async (tx) => {
    const ba = await createBankAccount(tx, companyId, opts);
    const opening = opts.openingBalance ?? 0n;
    if (opening !== 0n) {
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
      // Module 3: overdraft/credit-card accounts may open with a NEGATIVE
      // balance → Cr Bank / Dr Opening Equity; positive opens Dr Bank / Cr
      // Opening Equity (unchanged legacy behavior).
      const abs = opening < 0n ? -opening : opening;
      const [bankSide, equitySide] =
        opening > 0n
          ? [{ debit: abs, credit: 0n }, { debit: 0n, credit: abs }]
          : [{ debit: 0n, credit: abs }, { debit: abs, credit: 0n }];
      await tx.insert(journalLines).values([
        { id: crypto.randomUUID(), entryId, accountId: ba.accountId, ...bankSide },
        { id: crypto.randomUUID(), entryId, accountId: equityId, ...equitySide },
      ]);
    }
    return ba;
  });
}
