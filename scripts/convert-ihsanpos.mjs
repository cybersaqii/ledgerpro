#!/usr/bin/env node
/**
 * scripts/convert-ihsanpos.mjs
 * ─────────────────────────────────────────────────────────────────────────────
 * One-way converter: IhsanPOS JSON backup  →  LedgerPro backup-format JSON.
 *
 * The output is a LedgerPro backup payload (app: "LedgerPro", version: 1) that
 * the owner-only backup-restore flow accepts: every section from BACKUP_ARRAY_KEYS
 * is present, money is emitted as decimal strings (stringified bigints, paisa),
 * quantities as decimal strings (milli-units), dates as ISO strings.
 *
 * Usage:
 *   node scripts/convert-ihsanpos.mjs \
 *     --in  <ihsanpos-backup.json> \
 *     --out <ledgerpro-backup.json> \
 *     --company-id <target-company-uuid> \
 *     --company-name "<target company display name>"
 *
 * Design notes:
 * - Every financial movement is reconstructed as a balanced double-entry
 *   journal mirroring lib/posting.ts shapes (postSalesDoc / postPurchaseDoc /
 *   postPayment / postExpense). The script aborts if any journal is unbalanced.
 * - Per-party opening-balance journals (dated 2026-08-31) reconcile each
 *   party's converted-document total to the IhsanPOS currentBalance snapshot,
 *   so restored party balances match the source exactly.
 * - Stock is converted as a snapshot (stockLevels = currentStock); the 951
 *   IhsanPOS stockMovements are intentionally not replayed.
 * - This script only ADDS a file; it never touches the app, the DB, or git.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// ─── CLI ─────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function opt(name) {
  const i = argv.indexOf(name);
  if (i < 0 || i + 1 >= argv.length) {
    console.error(`Missing required argument: ${name} <value>`);
    process.exit(2);
  }
  return argv[i + 1];
}
const IN_PATH = opt("--in");
const OUT_PATH = opt("--out");
const CID = opt("--company-id");
const CNAME = opt("--company-name");

// ─── Small helpers ───────────────────────────────────────────────────────────

const uuid = () => randomUUID();
const CREATED_BY = "converter";

/** Rupees → paisa BigInt, round half away from zero. Throws on non-numbers. */
function paisa(rupees) {
  const n = Number(rupees ?? 0);
  if (!Number.isFinite(n)) throw new Error(`Bad money value: ${JSON.stringify(rupees)}`);
  const sign = n < 0 ? -1n : 1n;
  return sign * BigInt(Math.round(Math.abs(n) * 100));
}

/** Units → milli-units BigInt, round half away from zero. */
function milli(units) {
  const n = Number(units ?? 0);
  if (!Number.isFinite(n)) throw new Error(`Bad quantity value: ${JSON.stringify(units)}`);
  const sign = n < 0 ? -1n : 1n;
  return sign * BigInt(Math.round(Math.abs(n) * 1000));
}

/** round(qtyMilli * pricePaisa / 1000) half away from zero. */
function mulDivRound(qtyMilli, pricePaisa) {
  const num = qtyMilli * pricePaisa;
  const sign = num < 0n ? -1n : 1n;
  const abs = num < 0n ? -num : num;
  return sign * ((abs + 500n) / 1000n);
}

/** "YYYY-MM-DD" → ISO at 12:00 UTC (avoids any TZ-day shift). */
function isoDay(ymd) {
  if (typeof ymd !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(ymd))
    throw new Error(`Bad date value: ${JSON.stringify(ymd)}`);
  return `${ymd}T12:00:00.000Z`;
}

/** ISO instant passthrough (validates). */
function isoInstant(s, fallback) {
  if (typeof s === "string" && !Number.isNaN(Date.parse(s))) return new Date(s).toISOString();
  if (fallback) return fallback;
  throw new Error(`Bad instant value: ${JSON.stringify(s)}`);
}

const OPENING_DATE = isoDay("2026-08-31");

// ─── Report collector ────────────────────────────────────────────────────────

const report = {
  skipped: [],
  notes: [],
  skuRenames: [],
  synthesizedReceipts: [],
  openingDiffs: [],
  counts: {},
};
const note = (s) => report.notes.push(s);
const skip = (s) => report.skipped.push(s);

// ─── Load source ─────────────────────────────────────────────────────────────

const src = JSON.parse(readFileSync(IN_PATH, "utf8"));
if (!Array.isArray(src.products)) throw new Error("Input does not look like an IhsanPOS backup (no products array).");

// ─── Chart of accounts ───────────────────────────────────────────────────────
// Mirrors lib/setup.ts: 16 system accounts + one GL account per bank account
// (codes 1010+, same nextBankCode pattern) + an "Amanat Clearing" liability.

const SYS = {
  CASH: "1001", BANK: "1002", AR: "1100", INVENTORY: "1200", INPUT_TAX: "1300",
  AP: "2001", TAX_PAYABLE: "2100", CAPITAL: "3001", OPENING_EQUITY: "3002",
  SALES: "4001", SALES_RETURN: "4002", DISCOUNT_RECEIVED: "4010",
  COGS: "5001", PURCHASES: "5003", DISCOUNT_GIVEN: "5010", EXPENSES: "6000",
};
const SYSTEM_ACCOUNTS = [
  [SYS.CASH, "Cash in Hand", "ASSET"], [SYS.BANK, "Bank Account", "ASSET"],
  [SYS.AR, "Accounts Receivable", "ASSET"], [SYS.INVENTORY, "Inventory", "ASSET"],
  [SYS.INPUT_TAX, "Input Sales Tax", "ASSET"], [SYS.AP, "Accounts Payable", "LIABILITY"],
  [SYS.TAX_PAYABLE, "Sales Tax Payable", "LIABILITY"], [SYS.CAPITAL, "Owner's Capital", "EQUITY"],
  [SYS.OPENING_EQUITY, "Opening Balance Equity", "EQUITY"], [SYS.SALES, "Sales Revenue", "INCOME"],
  [SYS.SALES_RETURN, "Sales Returns", "INCOME"], [SYS.DISCOUNT_RECEIVED, "Discount Received", "INCOME"],
  [SYS.COGS, "Cost of Goods Sold", "EXPENSE"], [SYS.PURCHASES, "Purchases (Non-stock)", "EXPENSE"],
  [SYS.DISCOUNT_GIVEN, "Discount Given", "EXPENSE"], [SYS.EXPENSES, "General Expenses", "EXPENSE"],
];

const accounts = [];
const glIdByCode = {};
function addAccount(code, name, type, isSystem) {
  const id = uuid();
  accounts.push({
    id, companyId: CID, code, name, type, parentId: null,
    isSystem: !!isSystem, isActive: true, openingBalance: 0n,
  });
  glIdByCode[code] = id;
  return id;
}
for (const [code, name, type] of SYSTEM_ACCOUNTS) addAccount(code, name, type, true);
const AMANAT_GL = addAccount("2002", "Amanat Clearing", "LIABILITY", false);
note('Created liability GL account "Amanat Clearing" (code 2002) for the settled AMANAT nominal entries.');

// ─── Branches ────────────────────────────────────────────────────────────────

const BRANCH = uuid();
const branches = [{
  id: BRANCH, companyId: CID, name: "Main Branch", address: null, phone: null,
  isDefault: true, isActive: true,
}];

// ─── Bank accounts ───────────────────────────────────────────────────────────
// IhsanPOS has 4 (HBL, UBL, Allied = Bank; Easypaisa ZIA = Wallet) and its
// vouchers also reference "Cash in hand"/"Cash", so we add a CASH account too.

const bankAccounts = [];
const bankIdByName = {};   // source bank name (upper) -> new bank account id
const bankGlById = {};     // new bank account id -> GL account id
const bankNet = {};        // new bank account id -> BigInt net movement (for cached balance)
function addBankAccount(name, kind, bankName, accountNo) {
  const code = `10${String(10 + bankAccounts.length).padStart(2, "0")}`; // 1010, 1011, …
  const glId = addAccount(code, name, "ASSET", true);
  const id = uuid();
  bankAccounts.push({
    id, companyId: CID, name, bankName: bankName ?? null, accountNo: accountNo ?? null,
    kind, accountId: glId, openingBalance: 0n, balance: 0n, isActive: true,
  });
  bankGlById[id] = glId;
  bankNet[id] = 0n;
  return id;
}
const CASH_BANK = addBankAccount("Cash in Hand", "CASH");
bankIdByName[""] = CASH_BANK;
bankIdByName["CASH IN HAND"] = CASH_BANK;
bankIdByName["CASH"] = CASH_BANK;
for (const b of src.bankAccounts) {
  const kind = String(b.type || "").toLowerCase() === "wallet" ? "WALLET" : "BANK";
  const id = addBankAccount(b.name, kind, b.name, b.accountNumber);
  bankIdByName[String(b.name).toUpperCase()] = id;
}
function resolveBankAccount(accountName, ctx) {
  const key = String(accountName ?? "").trim().toUpperCase();
  const id = bankIdByName[key];
  if (!id) throw new Error(`Unmapped bank account "${accountName}" (${ctx}) — failing loudly per spec.`);
  return id;
}

// ─── Parties ─────────────────────────────────────────────────────────────────

const parties = [];
const partyBySourceId = {};   // IhsanPOS customer/supplier id -> new party id
const partyBalance = {};      // new party id -> IhsanPOS currentBalance (paisa)
const arOpen = {};            // new party id -> net AR movement from converted docs (paisa)
const apOpen = {};            // new party id -> net AP movement from converted docs (paisa)

function addParty(sourceId, kind, p) {
  const id = uuid();
  const name = String(p.name || "").trim();
  if (!name) throw new Error(`Party with empty name (${kind}, source ${sourceId})`);
  let notes = String(p.notes || "").trim() || null;
  if (kind === "CUSTOMER" && p.cnic) notes = (notes ? notes + " | " : "") + `CNIC: ${p.cnic}`;
  if (kind === "SUPPLIER" && p.companyName && p.companyName.trim() !== name)
    notes = (notes ? notes + " | " : "") + `Company: ${p.companyName.trim()}`;
  parties.push({
    id, companyId: CID, kind, name,
    phone: String(p.phone || "").trim() || null,
    email: null,
    address: String(p.address || "").trim() || null,
    city: null,
    ntn: String(p.ntn || "").trim() || null,
    filerStatus: "NA",
    creditLimit: paisa(p.creditLimit),
    balance: paisa(p.currentBalance),
    priceListId: null,
    isActive: !p.isDeleted && p.isActive !== false,
    notes,
    createdAt: isoInstant(p.createdAt, OPENING_DATE),
    updatedAt: isoInstant(p.createdAt, OPENING_DATE),
  });
  partyBySourceId[sourceId] = id;
  partyBalance[id] = paisa(p.currentBalance);
  arOpen[id] = 0n;
  apOpen[id] = 0n;
  return id;
}
for (const c of src.customers) addParty(c.id, "CUSTOMER", c);
for (const s of src.suppliers) addParty(s.id, "SUPPLIER", s);
const WALKIN_ID = partyBySourceId["cust-walkin"];
if (!WALKIN_ID) throw new Error("Walk-in customer (cust-walkin) not found in source.");

// ─── Products ────────────────────────────────────────────────────────────────
// Duplicate SKUs exist in the source (bulk-import artifacts, e.g. ITEM-3146 on
// 30 different products). LedgerPro enforces a unique (company_id, sku) index,
// so duplicates are deterministically disambiguated with a -2/-3 suffix and
// reported — never silently dropped.

const products = [];
const stockLevels = [];
const productBySourceId = {};
const seenSku = new Map();
for (const p of src.products) {
  let sku = String(p.sku || "").trim();
  if (!sku) throw new Error(`Product with empty SKU (source ${p.id}, ${p.name})`);
  if (seenSku.has(sku)) {
    const n = seenSku.get(sku) + 1;
    seenSku.set(sku, n);
    const newSku = `${sku}-${n}`;
    report.skuRenames.push(`${sku} → ${newSku} (${String(p.name).trim()})`);
    sku = newSku;
  } else {
    seenSku.set(sku, 1);
  }
  const id = uuid();
  const unit = String(p.unit || "").trim().toUpperCase() || "PCS";
  const godown = String(p.godown || "").trim();
  const rack = String(p.locationRack || "").trim();
  const location = [godown, rack].filter(Boolean).join(" · ") || null;
  const costP = paisa(p.costPrice);
  products.push({
    id, companyId: CID, sku,
    name: String(p.name || "").trim(),
    barcode: String(p.barcode || "").trim() || null,
    category: String(p.category || "").trim() || null,
    unit,
    purchasePrice: costP,
    salePrice: paisa(p.salePrice),
    taxBps: 0,
    trackStock: true,
    reorderLevel: milli(p.minStockAlert),
    minSalePrice: 0n,
    location,
    isActive: p.isActive !== false,
    createdAt: isoInstant(p.createdAt, OPENING_DATE),
    updatedAt: isoInstant(p.updatedAt || p.createdAt, OPENING_DATE),
  });
  // Snapshot stock: current levels only (stockMovements intentionally skipped).
  stockLevels.push({
    id: uuid(), productId: id, branchId: BRANCH,
    qty: milli(p.currentStock), avgCost: costP,
  });
  productBySourceId[p.id] = id;
}
note("Dropped per-product fields with no LedgerPro column: wholesalePrice, brand, warrantyMonths.");

// ─── Journal builder (mirrors lib/posting.ts shapes) ─────────────────────────

const journalEntries = [];
const journalLines = [];

/**
 * lines: [{ gl, debit: bigint, credit: bigint, partyId?, memo? }]
 * Aborts the whole conversion on any imbalance — a half-written ledger is
 * worse than no ledger.
 */
function addJournal({ date, memo, reference, source, sourceId, lines }) {
  const nz = lines.filter((l) => l.debit !== 0n || l.credit !== 0n);
  const d = nz.reduce((a, l) => a + l.debit, 0n);
  const c = nz.reduce((a, l) => a + l.credit, 0n);
  if (d !== c) throw new Error(`Journal OUT OF BALANCE [${memo}]: debits ${d} ≠ credits ${c}`);
  if (d <= 0n) throw new Error(`Journal total not positive [${memo}] — refusing to post a zero journal.`);
  for (const l of nz) {
    if (l.debit < 0n || l.credit < 0n) throw new Error(`Negative journal amount [${memo}]`);
    if (l.debit > 0n && l.credit > 0n) throw new Error(`Line has both debit and credit [${memo}]`);
    if (!glIdByCode[l.gl]) throw new Error(`Unknown GL code ${l.gl} [${memo}]`);
  }
  const id = uuid();
  journalEntries.push({
    id, companyId: CID, branchId: BRANCH, date, memo,
    reference: reference ?? null, source, sourceId: sourceId ?? null,
    createdById: CREATED_BY, createdAt: date,
  });
  for (const l of nz) {
    journalLines.push({
      id: uuid(), entryId: id, accountId: glIdByCode[l.gl],
      debit: l.debit, credit: l.credit,
      partyId: l.partyId ?? null, memo: l.memo ?? null,
    });
  }
  return id;
}

const GL = {
  AR: SYS.AR, AP: SYS.AP, SALES: SYS.SALES, SALES_RETURN: SYS.SALES_RETURN,
  COGS: SYS.COGS, INVENTORY: SYS.INVENTORY, DISCOUNT_GIVEN: SYS.DISCOUNT_GIVEN,
  DISCOUNT_RECEIVED: SYS.DISCOUNT_RECEIVED, EXPENSES: SYS.EXPENSES,
  TAX_PAYABLE: SYS.TAX_PAYABLE, INPUT_TAX: SYS.INPUT_TAX,
  OPENING_EQUITY: SYS.OPENING_EQUITY,
};
const AMANAT = "2002";

function bumpBank(bankId, delta) { bankNet[bankId] += delta; }

// ─── Documents ───────────────────────────────────────────────────────────────

const salesDocs = [];
const salesDocItems = [];
const purchaseDocs = [];
const purchaseDocItems = [];
const payments = [];
const paymentAllocations = [];
const expenses = [];

const METHOD_MAP = { "Cash": "CASH", "Bank Transfer": "BANK", "Cheque": "CHEQUE" };
function mapMethod(m, ctx) {
  if (METHOD_MAP[m]) return METHOD_MAP[m];
  // "Credit (Khata)" has no LedgerPro enum value; the column is free text and
  // the list UI renders it as-is, so keep the original label (reported).
  note(`Kept source payment method label "${m}" (${ctx}).`);
  return m;
}

function mapProduct(sourceId, ctx) {
  const id = productBySourceId[sourceId];
  if (!id) throw new Error(`Item references unknown product ${sourceId} (${ctx}) — failing loudly per spec.`);
  return id;
}

// Allocation state per sales doc: remaining balance for receipt allocation.
const saleRemaining = {}; // new doc id -> BigInt
function allocToSale(paymentId, partyId, docId, amount) {
  const rem = saleRemaining[docId] ?? 0n;
  const a = amount < rem ? amount : rem;
  if (a > 0n) {
    paymentAllocations.push({
      id: uuid(), paymentId, partyId, salesDocId: docId,
      purchaseDocId: null, amount: a,
    });
    saleRemaining[docId] = rem - a;
  }
  return a;
}

// ─── Sales → INVOICE docs ────────────────────────────────────────────────────

const SALE_STATUS = { "Paid": "PAID", "Partially Paid": "PARTIAL", "Posted": "POSTED" };
let saleCount = 0;

function buildSaleItems(sale, docId) {
  return sale.items.map((it) => ({
    id: uuid(),
    docId,
    productId: mapProduct(it.productId, `sale ${sale.invoiceNumber}`),
    description: String(it.productName || "").trim(),
    qty: milli(it.quantity),
    qtyReturned: 0n,
    rate: paisa(it.unitPrice),
    discount: paisa(it.discount),
    taxBps: 0,
    taxAmount: 0n,
    lineTotal: paisa(it.total),
  }));
}

function postSaleJournal(sale, docId, partyId, items, grossSales, discountTotal, taxTotal, grandTotal, cogsNet) {
  // The source has 7 invoices whose line totals, discount and netTotal don't
  // reconcile (data-entry quirks, up to Rs 119). The journal must balance on
  // the legal totals, so the discount line is derived as a plug:
  //   plug = grossSales + taxTotal − grandTotal
  // plug > 0 → genuine discount (Dr DISCOUNT_GIVEN); plug ≤ 0 → the charged
  // amount is booked straight to revenue (no discount line).
  const plug = grossSales + taxTotal - grandTotal;
  if (plug !== discountTotal) {
    note(`Invoice ${sale.invoiceNumber}: source discount ${discountTotal / 100n} doesn't reconcile ` +
      `(lines − discount + tax ≠ netTotal); journal uses derived discount ${plug > 0n ? plug / 100n : 0n}.`);
  }
  const entryId = addJournal({
    date: isoDay(sale.date),
    memo: `Sales invoice ${sale.invoiceNumber}`,
    reference: sale.invoiceNumber,
    source: "SALES",
    sourceId: docId,
    lines: [
      { gl: GL.AR, debit: grandTotal, credit: 0n, partyId },
      { gl: GL.SALES, debit: 0n, credit: plug > 0n ? grossSales : grandTotal - taxTotal },
      ...(taxTotal > 0n ? [{ gl: GL.TAX_PAYABLE, debit: 0n, credit: taxTotal }] : []),
      ...(plug > 0n ? [{ gl: GL.DISCOUNT_GIVEN, debit: plug, credit: 0n }] : []),
      ...(cogsNet > 0n
        ? [{ gl: GL.COGS, debit: cogsNet, credit: 0n }, { gl: GL.INVENTORY, debit: 0n, credit: cogsNet }]
        : cogsNet < 0n
          ? [{ gl: GL.INVENTORY, debit: -cogsNet, credit: 0n }, { gl: GL.COGS, debit: 0n, credit: -cogsNet }]
          : []),
    ],
  });
  return entryId;
}

function convertSale(sale) {
  const docId = uuid();
  const partyId = partyBySourceId[sale.customerId];
  if (!partyId) throw new Error(`Sale ${sale.invoiceNumber} references unknown customer ${sale.customerId}`);
  const date = isoDay(sale.date);
  const createdAt = isoInstant(sale.createdAt, date);

  const items = buildSaleItems(sale, docId);
  const grossSales = items.reduce((a, it) => a + it.lineTotal, 0n);
  const discountTotal = paisa(sale.discountTotal);
  const taxTotal = paisa(sale.taxTotal);
  const grandTotal = paisa(sale.netTotal);
  const cogsNet = sale.items.reduce(
    (a, it) => a + mulDivRound(milli(it.quantity), paisa(it.costPrice ?? 0)), 0n);

  const entryId = postSaleJournal(sale, docId, partyId, items, grossSales, discountTotal, taxTotal, grandTotal, cogsNet);

  salesDocs.push({
    id: docId, companyId: CID, branchId: BRANCH, partyId,
    docType: "INVOICE", docNo: sale.invoiceNumber, date, dueDate: null,
    status: SALE_STATUS[sale.status] ?? (() => { throw new Error(`Unknown sale status "${sale.status}"`); })(),
    subtotal: paisa(sale.subtotal), discountTotal, taxTotal, grandTotal,
    amountPaid: paisa(sale.paidAmount),
    notes: String(sale.notes || "").trim() || null,
    journalEntryId: entryId, sourceDocId: null,
    createdById: CREATED_BY, createdAt, updatedAt: createdAt,
  });
  salesDocItems.push(...items);
  saleRemaining[docId] = grandTotal;
  arOpen[partyId] += grandTotal;
  saleCount++;
  return { docId, partyId, date, createdAt };
}

for (const s of src.sales) {
  if (s.status === "Cancelled") { skip(`Cancelled sale ${s.invoiceNumber} (${s.date}) — not converted.`); continue; }
  convertSale(s);
}

// ─── Receipts from sale.payments[] + synthesized counter receipts ────────────

let receiptCount = 0;
function addReceipt({ partyId, bankId, date, createdAt, amount, method, reference, notes }, countAsSale = true) {
  if (amount <= 0n) return null;
  const entryId = addJournal({
    date, memo: `Receipt${reference ? ` ${reference}` : ""}`,
    reference, source: "PAYMENT", sourceId: null,
    lines: [
      { gl: bankGlCode(bankId), debit: amount, credit: 0n },
      { gl: GL.AR, debit: 0n, credit: amount, partyId },
    ],
  });
  const id = uuid();
  payments.push({
    id, companyId: CID, branchId: BRANCH, kind: "RECEIPT", date, partyId,
    bankAccountId: bankId, amount, method, reference: reference ?? null,
    notes: notes ?? null, journalEntryId: entryId,
    createdById: CREATED_BY, createdAt,
  });
  bumpBank(bankId, amount);
  arOpen[partyId] -= amount;
  if (countAsSale) receiptCount++;
  return id;
}

// bank GL code lookup: bank account id -> GL code
const bankCodeById = {};
for (const b of bankAccounts) {
  const acct = accounts.find((a) => a.id === b.accountId);
  bankCodeById[b.id] = acct.code;
}
function bankGlCode(bankId) { return bankCodeById[bankId]; }

for (const s of src.sales) {
  if (s.status === "Cancelled") continue;
  const docId = salesDocs.find((d) => d.docNo === s.invoiceNumber && d.docType === "INVOICE")?.id;
  const partyId = partyBySourceId[s.customerId];
  const pays = s.payments || [];
  if (pays.length === 0 && paisa(s.paidAmount) > 0n) {
    // Counter cash sales recorded as Paid with no itemized payment rows:
    // synthesize one receipt so cash + AR stay truthful to the source status.
    const bankId = resolveBankAccount("", `synthesized receipt for ${s.invoiceNumber}`);
    const pid = addReceipt({
      partyId, bankId, date: isoDay(s.date), createdAt: isoInstant(s.createdAt, isoDay(s.date)),
      amount: paisa(s.paidAmount), method: mapMethod(s.paymentMethod, s.invoiceNumber),
      reference: `${s.id}-synth`, notes: "Synthesized from paidAmount (no itemized payment rows in source)",
    });
    if (pid && docId) allocToSale(pid, partyId, docId, paisa(s.paidAmount));
    report.synthesizedReceipts.push(`${s.invoiceNumber}: ${s.paidAmount} (${s.paymentMethod})`);
    continue;
  }
  for (const p of pays) {
    const amt = paisa(p.amount);
    if (amt <= 0n) { skip(`Zero-amount payment ${p.id} on ${s.invoiceNumber} — skipped.`); continue; }
    const bankId = resolveBankAccount(p.accountName, `payment ${p.id} on ${s.invoiceNumber}`);
    const pid = addReceipt({
      partyId, bankId, date: isoDay(p.date || s.date),
      createdAt: isoInstant(p.recordedAt, isoDay(p.date || s.date)),
      amount: amt, method: mapMethod(p.paymentMethod, s.invoiceNumber),
      reference: p.id, notes: p.notes || null,
    });
    if (pid && docId) allocToSale(pid, partyId, docId, amt);
  }
}

// ─── Purchases → BILL docs ───────────────────────────────────────────────────
// PUR-2026-0027 is a net-negative bill (a -5-fan return netted inside a bill).
// LedgerPro journals cannot carry negative amounts, so it is split into a BILL
// (the positive lines) and a purchase RETURN (the negative line) — the
// accounting-correct treatment, fully reported.

const PURCHASE_STATUS = { "Paid": "PAID", "Partially Paid": "PARTIAL", "Posted": "POSTED" };
let billCount = 0, purchaseReturnCount = 0;

function postPurchaseJournal({ docNo, date, partyId, docId, stockNet, nonStockNet, discountTotal, taxTotal, grandTotal, isReturn }) {
  return addJournal({
    date,
    memo: isReturn ? `Purchase return ${docNo}` : `Purchase bill ${docNo}`,
    reference: docNo,
    source: "PURCHASE",
    sourceId: docId,
    lines: isReturn
      ? [
          { gl: GL.AP, debit: grandTotal, credit: 0n, partyId },
          ...(stockNet > 0n ? [{ gl: GL.INVENTORY, debit: 0n, credit: stockNet }] : []),
          ...(nonStockNet > 0n ? [{ gl: GL.PURCHASES, debit: 0n, credit: nonStockNet }] : []),
          ...(taxTotal > 0n ? [{ gl: GL.INPUT_TAX, debit: 0n, credit: taxTotal }] : []),
          ...(discountTotal > 0n ? [{ gl: GL.DISCOUNT_RECEIVED, debit: discountTotal, credit: 0n }] : []),
        ]
      : [
          ...(stockNet > 0n ? [{ gl: GL.INVENTORY, debit: stockNet, credit: 0n }] : []),
          ...(nonStockNet > 0n ? [{ gl: GL.PURCHASES, debit: nonStockNet, credit: 0n }] : []),
          ...(taxTotal > 0n ? [{ gl: GL.INPUT_TAX, debit: taxTotal, credit: 0n }] : []),
          { gl: GL.AP, debit: 0n, credit: grandTotal, partyId },
          ...(discountTotal > 0n ? [{ gl: GL.DISCOUNT_RECEIVED, debit: 0n, credit: discountTotal }] : []),
        ],
  });
}

function buildPurchaseItems(p, docId) {
  return p.items.map((it) => ({
    id: uuid(),
    docId,
    productId: mapProduct(it.productId, `purchase ${p.purchaseNumber}`),
    description: String(it.productName || "").trim(),
    qty: milli(Math.abs(it.quantity)),
    qtyReturned: 0n,
    rate: paisa(it.unitCost),
    discount: 0n,
    taxBps: 0,
    taxAmount: 0n,
    lineTotal: paisa(Math.abs(it.total)),
    extraCost: 0n,
  }));
}

function convertPurchaseBill(p, { docNo, items: rawItems, isReturn, billDiscount, billTax, billSubtotal, billNet }) {
  const docId = uuid();
  const partyId = partyBySourceId[p.supplierId];
  if (!partyId) throw new Error(`Purchase ${p.purchaseNumber} references unknown supplier ${p.supplierId}`);
  const date = isoDay(p.date);
  const createdAt = isoInstant(p.createdAt, date);
  const docType = isReturn ? "RETURN" : "BILL";

  const items = rawItems.map((it) => ({
    id: uuid(),
    docId,
    productId: mapProduct(it.productId, `purchase ${docNo}`),
    description: String(it.productName || "").trim(),
    qty: milli(Math.abs(it.quantity)),
    qtyReturned: 0n,
    rate: paisa(it.unitCost),
    discount: 0n,
    taxBps: 0,
    taxAmount: 0n,
    lineTotal: paisa(Math.abs(it.total)),
    extraCost: 0n,
  }));

  const stockNet = items.reduce((a, it) => a + it.lineTotal, 0n);
  // For split bills the caller passes the bill-level amounts explicitly; for
  // whole bills they come from the source document.
  const discountTotal = isReturn ? 0n : paisa(billDiscount ?? p.discountTotal);
  const taxTotal = isReturn ? 0n : paisa(billTax ?? p.taxTotal);
  const grandTotal = isReturn ? stockNet : paisa(billNet ?? p.netTotal);

  const entryId = postPurchaseJournal({
    docNo, date, partyId, docId, stockNet, nonStockNet: 0n,
    discountTotal, taxTotal, grandTotal, isReturn,
  });

  purchaseDocs.push({
    id: docId, companyId: CID, branchId: BRANCH, partyId,
    docType, docNo, date, dueDate: null,
    status: isReturn ? "POSTED" : (PURCHASE_STATUS[p.status] ?? (() => { throw new Error(`Unknown purchase status "${p.status}"`); })()),
    subtotal: isReturn ? stockNet : paisa(billSubtotal ?? p.subtotal),
    discountTotal, taxTotal, grandTotal,
    amountPaid: isReturn ? 0n : paisa(p.paidAmount),
    refNo: null,
    notes: [String(p.notes || "").trim(), isReturn ? `Split from ${p.purchaseNumber} (net-negative bill in source)` : ""]
      .filter(Boolean).join(" | ") || null,
    journalEntryId: entryId, sourceDocId: null,
    createdById: CREATED_BY, createdAt, updatedAt: createdAt,
  });
  purchaseDocItems.push(...items);
  if (isReturn) { apOpen[partyId] -= grandTotal; purchaseReturnCount++; }
  else { apOpen[partyId] += grandTotal; billCount++; }
  return { docId, partyId, date, createdAt };
}

for (const p of src.purchases) {
  if (p.status === "Cancelled") { skip(`Cancelled purchase ${p.purchaseNumber} (${p.date}) — not converted.`); continue; }
  const neg = p.items.filter((it) => it.quantity < 0);
  if (neg.length > 0) {
    // A bill with return lines netted inside: split into BILL + RETURN docs.
    // (LedgerPro journals cannot carry negative amounts.)
    const pos = p.items.filter((it) => it.quantity >= 0);
    if (pos.length === 0)
      throw new Error(`Purchase ${p.purchaseNumber} has only negative lines — cannot split.`);
    const posTotal = pos.reduce((a, it) => a + Number(it.total), 0);
    convertPurchaseBill(p, {
      docNo: p.purchaseNumber, items: pos, isReturn: false,
      billSubtotal: posTotal, billNet: posTotal - Number(p.discountTotal || 0) + Number(p.taxTotal || 0),
    });
    convertPurchaseBill(p, { docNo: `${p.purchaseNumber}-R`, items: neg, isReturn: true });
    note(`Split purchase ${p.purchaseNumber} (had ${neg.length} return line(s) netted in) into ` +
      `BILL ${p.purchaseNumber} + RETURN ${p.purchaseNumber}-R.`);
    continue;
  }
  convertPurchaseBill(p, { docNo: p.purchaseNumber, items: p.items, isReturn: false });
}

// Cash-paid purchase bills → PAYMENT entries (cash out), allocated to the bill.
for (const p of src.purchases) {
  if (p.status === "Cancelled") continue;
  const paid = paisa(p.paidAmount);
  if (paid <= 0n) continue;
  const partyId = partyBySourceId[p.supplierId];
  const bankId = resolveBankAccount(p.accountName, `purchase payment ${p.purchaseNumber}`);
  const date = isoDay(p.date);
  const entryId = addJournal({
    date, memo: `Payment ${p.purchaseNumber}`, reference: p.purchaseNumber,
    source: "PAYMENT", sourceId: null,
    lines: [
      { gl: GL.AP, debit: paid, credit: 0n, partyId },
      { gl: bankGlCode(bankId), debit: 0n, credit: paid },
    ],
  });
  const doc = purchaseDocs.find((d) => d.docNo === p.purchaseNumber && d.docType === "BILL");
  const id = uuid();
  payments.push({
    id, companyId: CID, branchId: BRANCH, kind: "PAYMENT", date, partyId,
    bankAccountId: bankId, amount: paid, method: mapMethod(p.paymentMethod, p.purchaseNumber),
    reference: p.id, notes: `Supplier payment for ${p.purchaseNumber}`,
    journalEntryId: entryId, createdById: CREATED_BY, createdAt: isoInstant(p.createdAt, date),
  });
  if (doc) paymentAllocations.push({
    id: uuid(), paymentId: id, partyId, salesDocId: null, purchaseDocId: doc.id, amount: paid,
  });
  bumpBank(bankId, -paid);
  apOpen[partyId] -= paid;
  note(`Purchase ${p.purchaseNumber} was cash-paid in source — created PAYMENT of ${p.paidAmount}.`);
}

// ─── Payment vouchers ────────────────────────────────────────────────────────
// CASH_IN_CUSTOMER → RECEIPT (general receipt, no doc allocation — the source
// links none). SHOP_EXPENSE → expense row. VOIDED / zero-amount rows skipped.

let voucherReceipts = 0, expenseCount = 0;
for (const v of src.paymentVouchers) {
  const date = isoDay(v.date);
  const createdAt = isoInstant(v.timestamp || v.createdAt, date);
  const amount = paisa(v.amount);
  if (v.status === "VOIDED") { skip(`VOIDED voucher ${v.voucherNumber} (${v.type}, ${v.amount}) — not converted.`); continue; }

  if (v.type === "CASH_IN_CUSTOMER") {
    if (amount <= 0n) { skip(`Zero-amount voucher ${v.voucherNumber} — not converted.`); continue; }
    const partyId = partyBySourceId[v.partyId];
    if (!partyId) throw new Error(`Voucher ${v.voucherNumber} references unknown party ${v.partyId}`);
    const bankId = resolveBankAccount(v.accountName, `voucher ${v.voucherNumber}`);
    addReceipt({
      partyId, bankId, date, createdAt, amount,
      method: mapMethod(v.paymentMethod, v.voucherNumber),
      reference: v.voucherNumber,
      notes: [v.reason, v.notes].filter(Boolean).join(" | ") || null,
    }, false);
    voucherReceipts++;
  } else if (v.type === "SHOP_EXPENSE") {
    if (amount <= 0n) { skip(`Zero-amount expense voucher ${v.voucherNumber} — not converted.`); continue; }
    const bankId = resolveBankAccount(v.accountName, `voucher ${v.voucherNumber}`);
    const entryId = addJournal({
      date, memo: `Expense — ${v.partyName || v.voucherNumber}`, reference: v.voucherNumber,
      source: "EXPENSE", sourceId: null,
      lines: [
        { gl: GL.EXPENSES, debit: amount, credit: 0n },
        { gl: bankGlCode(bankId), debit: 0n, credit: amount },
      ],
    });
    expenses.push({
      id: uuid(), companyId: CID, branchId: BRANCH, date,
      accountId: glIdByCode[SYS.EXPENSES], bankAccountId: bankId,
      amount, taxAmount: 0n,
      notes: [`Shop expense: ${v.partyName || ""}`.trim(), v.reason, v.notes].filter(Boolean).join(" | ") || null,
      journalEntryId: entryId, createdById: CREATED_BY, createdAt,
    });
    bumpBank(bankId, -amount);
    expenseCount++;
  } else {
    skip(`Unknown voucher type "${v.type}" on ${v.voucherNumber} — not converted.`);
  }
}

// ─── Nominal entries (settled AMANAT account) ────────────────────────────────
// PAID 60000 then RECEIVED 60000 on a closed account: net zero. Reconstructed
// as two balanced journals through the Amanat Clearing liability account.

const nominalSorted = [...src.nominalEntries].sort((a, b) =>
  String(a.entryNumber).localeCompare(String(b.entryNumber)));
for (const e of nominalSorted) {
  const amount = paisa(e.amount);
  const bankId = resolveBankAccount(e.accountName, `nominal entry ${e.entryNumber}`);
  const date = isoDay(e.date);
  if (e.kind === "PAID") {
    addJournal({
      date, memo: `Amanat paid out (${e.entryNumber})`, reference: e.entryNumber,
      source: "MANUAL", sourceId: null,
      lines: [
        { gl: AMANAT, debit: amount, credit: 0n },
        { gl: bankGlCode(bankId), debit: 0n, credit: amount },
      ],
    });
  } else if (e.kind === "RECEIVED") {
    addJournal({
      date, memo: `Amanat received (${e.entryNumber})`, reference: e.entryNumber,
      source: "MANUAL", sourceId: null,
      lines: [
        { gl: bankGlCode(bankId), debit: amount, credit: 0n },
        { gl: AMANAT, debit: 0n, credit: amount },
      ],
    });
  } else {
    throw new Error(`Unknown nominal entry kind "${e.kind}" (${e.entryNumber})`);
  }
  bumpBank(bankId, e.kind === "PAID" ? -amount : amount);
}
note("Nominal AMANAT entries (60000 PAID + 60000 RECEIVED) net to zero; account was settled/closed in source.");

// ─── Sale returns → RETURN docs ──────────────────────────────────────────────

for (const r of src.saleReturns) {
  const docId = uuid();
  const partyId = partyBySourceId[r.customerId];
  if (!partyId) throw new Error(`Return ${r.returnNumber} references unknown customer ${r.customerId}`);
  const origDoc = salesDocs.find((d) => d.docNo === r.originalInvoiceNumber && d.docType === "INVOICE");
  const date = isoDay(r.date);
  const createdAt = isoInstant(r.createdAt, date);

  const items = r.items.map((it) => ({
    id: uuid(), docId,
    productId: mapProduct(it.productId, `return ${r.returnNumber}`),
    description: String(it.productName || "").trim(),
    qty: milli(it.quantity), qtyReturned: 0n,
    rate: paisa(it.unitPrice), discount: 0n, taxBps: 0, taxAmount: 0n,
    lineTotal: paisa(it.refundTotal),
  }));
  const grossSales = items.reduce((a, it) => a + it.lineTotal, 0n);
  const grandTotal = paisa(r.refundAmount);
  const cogsIn = r.items.reduce(
    (a, it) => a + mulDivRound(milli(it.quantity), paisa(it.costPrice ?? 0)), 0n);

  const entryId = addJournal({
    date, memo: `Sales return ${r.returnNumber}`, reference: r.returnNumber,
    source: "SALES", sourceId: docId,
    lines: [
      { gl: GL.SALES_RETURN, debit: grossSales, credit: 0n },
      { gl: GL.AR, debit: 0n, credit: grandTotal, partyId },
      ...(cogsIn > 0n
        ? [{ gl: GL.INVENTORY, debit: cogsIn, credit: 0n }, { gl: GL.COGS, debit: 0n, credit: cogsIn }]
        : []),
    ],
  });

  salesDocs.push({
    id: docId, companyId: CID, branchId: BRANCH, partyId,
    docType: "RETURN", docNo: r.returnNumber, date, dueDate: null,
    status: "PAID", // fully refunded in cash below
    subtotal: grossSales, discountTotal: 0n, taxTotal: 0n, grandTotal,
    amountPaid: grandTotal,
    notes: [`Return of ${r.originalInvoiceNumber}`, r.reason].filter(Boolean).join(" | "),
    journalEntryId: entryId, sourceDocId: origDoc ? origDoc.id : null,
    createdById: CREATED_BY, createdAt, updatedAt: createdAt,
  });
  salesDocItems.push(...items);
  arOpen[partyId] -= grandTotal;

  // Cash refund to the customer. NOTE: posted as Dr AR / Cr Cash (the
  // accounting-correct entry for a customer refund); lib/posting.ts's PAYMENT
  // shape uses Dr AP, which fits suppliers, not customers.
  const bankId = resolveBankAccount("Cash in hand", `refund ${r.returnNumber}`);
  const payEntryId = addJournal({
    date, memo: `Refund ${r.returnNumber}`, reference: r.returnNumber,
    source: "PAYMENT", sourceId: null,
    lines: [
      { gl: GL.AR, debit: grandTotal, credit: 0n, partyId },
      { gl: bankGlCode(bankId), debit: 0n, credit: grandTotal },
    ],
  });
  const payId = uuid();
  payments.push({
    id: payId, companyId: CID, branchId: BRANCH, kind: "PAYMENT", date, partyId,
    bankAccountId: bankId, amount: grandTotal, method: mapMethod(r.refundMethod, r.returnNumber),
    reference: r.returnNumber, notes: `Cash refund for ${r.returnNumber}`,
    journalEntryId: payEntryId, createdById: CREATED_BY, createdAt,
  });
  paymentAllocations.push({
    id: uuid(), paymentId: payId, partyId, salesDocId: docId, purchaseDocId: null, amount: grandTotal,
  });
  bumpBank(bankId, -grandTotal);
  arOpen[partyId] += grandTotal;
  note(`Sale return ${r.returnNumber}: refunded ${r.refundAmount} in cash (PAYMENT allocated to the RETURN doc).`);
}

// ─── Quotations → QUOTATION docs (DRAFT, no journals) ────────────────────────

let quoCount = 0;
for (const q of src.quotations) {
  const docId = uuid();
  const date = isoDay(q.date);
  const createdAt = isoInstant(q.createdAt, date);
  // Match customer by name (case-insensitive, contains-either-way); fall back
  // to the walk-in customer and report it.
  let partyId = WALKIN_ID;
  let matchedNote = "walk-in fallback";
  const qn = String(q.customerName || "").trim().toLowerCase();
  if (qn) {
    const hit = parties.find((p) =>
      p.kind === "CUSTOMER" &&
      (p.name.toLowerCase() === qn || p.name.toLowerCase().includes(qn) || qn.includes(p.name.toLowerCase())));
    if (hit) { partyId = hit.id; matchedNote = `matched "${hit.name}"`; }
  }
  const items = q.items.map((it) => ({
    id: uuid(), docId,
    productId: mapProduct(it.productId, `quotation ${q.quotationNumber}`),
    description: String(it.productName || "").trim(),
    qty: milli(it.quantity), qtyReturned: 0n,
    rate: paisa(it.unitPrice), discount: 0n, taxBps: 0, taxAmount: 0n,
    lineTotal: paisa(it.total),
  }));
  salesDocs.push({
    id: docId, companyId: CID, branchId: BRANCH, partyId,
    docType: "QUOTATION", docNo: q.quotationNumber, date, dueDate: null,
    status: "DRAFT",
    subtotal: paisa(q.subtotal), discountTotal: paisa(q.discountTotal),
    taxTotal: 0n, grandTotal: paisa(q.netTotal),
    amountPaid: 0n, notes: `Validity: ${q.validityDays ?? "?"} days`,
    journalEntryId: null, sourceDocId: null,
    createdById: CREATED_BY, createdAt, updatedAt: createdAt,
  });
  salesDocItems.push(...items);
  quoCount++;
  note(`Quotation ${q.quotationNumber}: party ${matchedNote}.`);
}

// ─── Per-party opening balances ──────────────────────────────────────────────
// Reconcile each party's converted-document total to the IhsanPOS
// currentBalance snapshot with one balanced journal dated 2026-08-31.

let openingCount = 0;
for (const p of parties) {
  const open = p.kind === "CUSTOMER" ? arOpen[p.id] : apOpen[p.id];
  const diff = partyBalance[p.id] - open;
  if (diff === 0n) continue;
  const acct = p.kind === "CUSTOMER" ? GL.AR : GL.AP;
  const ad = diff > 0n ? diff : -diff;
  const lines = p.kind === "CUSTOMER"
    ? diff > 0n
      ? [{ gl: acct, debit: ad, credit: 0n, partyId: p.id }, { gl: GL.OPENING_EQUITY, debit: 0n, credit: ad }]
      : [{ gl: GL.OPENING_EQUITY, debit: ad, credit: 0n }, { gl: acct, debit: 0n, credit: ad, partyId: p.id }]
    : diff > 0n
      ? [{ gl: GL.OPENING_EQUITY, debit: ad, credit: 0n }, { gl: acct, debit: 0n, credit: ad, partyId: p.id }]
      : [{ gl: acct, debit: ad, credit: 0n, partyId: p.id }, { gl: GL.OPENING_EQUITY, debit: 0n, credit: ad }];
  addJournal({
    date: OPENING_DATE,
    memo: `Opening balance — ${p.name}`,
    reference: null, source: "OPENING", sourceId: null, lines,
  });
  openingCount++;
  const adAbs = ad; // already absolute
  const rupees = adAbs / 100n, ps = adAbs % 100n;
  report.openingDiffs.push({
    party: p.name, kind: p.kind,
    diff: `${diff < 0n ? "-" : ""}${rupees}.${String(ps).padStart(2, "0")}`,
  });
}

// ─── Finalize bank balances (cached column) ──────────────────────────────────

for (const b of bankAccounts) b.balance = bankNet[b.id];

// ─── Number sequences ────────────────────────────────────────────────────────

const DOC_PREFIXES = {
  INVOICE: "INV-", QUOTATION: "QUO-", ORDER: "ORD-", CHALLAN: "CHL-", RETURN: "SR-",
  BILL: "BIL-", GRN: "GRN-", PAYMENT: "PAY-", RECEIPT: "REC-", EXPENSE: "EXP-",
};
const LAST_NO = { INVOICE: 126, BILL: 44, QUOTATION: 2, RETURN: 1, RECEIPT: 13, PAYMENT: 3 };
const numberSequences = Object.entries(DOC_PREFIXES).map(([docType, prefix]) => ({
  id: uuid(), companyId: CID, docType, prefix, lastNo: LAST_NO[docType] ?? 0,
}));

// ─── Assemble payload ────────────────────────────────────────────────────────

const payload = {
  exportedAt: new Date().toISOString(),
  app: "LedgerPro",
  version: 1,
  company: { id: CID, name: CNAME },
  branches, accounts, parties, products, bankAccounts,
  salesDocs, salesDocItems, purchaseDocs, purchaseDocItems,
  payments, paymentAllocations, expenses,
  journalEntries, journalLines, stockLevels, numberSequences,
};

report.counts = {
  branches: branches.length, accounts: accounts.length, parties: parties.length,
  products: products.length, bankAccounts: bankAccounts.length,
  salesDocs: salesDocs.length, salesDocItems: salesDocItems.length,
  purchaseDocs: purchaseDocs.length, purchaseDocItems: purchaseDocItems.length,
  payments: payments.length, paymentAllocations: paymentAllocations.length,
  expenses: expenses.length, journalEntries: journalEntries.length,
  journalLines: journalLines.length, stockLevels: stockLevels.length,
  numberSequences: numberSequences.length,
  invoices: saleCount, bills: billCount, purchaseReturns: purchaseReturnCount,
  quotations: quoCount, receiptsFromSales: receiptCount,
  voucherReceipts, expensesFromVouchers: expenseCount, openingJournals: openingCount,
};

const json = JSON.stringify(payload, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
writeFileSync(OUT_PATH, json);

// ─── Report ──────────────────────────────────────────────────────────────────

console.log("Conversion complete.");
console.log(`  Output: ${OUT_PATH} (${(Buffer.byteLength(json, "utf8") / 1024).toFixed(1)} KB)`);
console.log("  Section counts:", JSON.stringify(report.counts));
if (report.skipped.length) {
  console.log(`  Skipped (${report.skipped.length}):`);
  for (const s of report.skipped) console.log(`    - ${s}`);
}
if (report.skuRenames.length) {
  console.log(`  Duplicate SKUs disambiguated (${report.skuRenames.length}):`);
  for (const s of report.skuRenames.slice(0, 10)) console.log(`    - ${s}`);
  if (report.skuRenames.length > 10) console.log(`    … and ${report.skuRenames.length - 10} more`);
}
if (report.synthesizedReceipts.length) {
  console.log(`  Synthesized receipts (${report.synthesizedReceipts.length}):`);
  for (const s of report.synthesizedReceipts) console.log(`    - ${s}`);
}
const bigDiffs = report.openingDiffs;
console.log(`  Parties needing opening-balance journals: ${bigDiffs.length}/${parties.length}`);
for (const d of bigDiffs.slice(0, 15))
  console.log(`    - [${d.kind}] ${d.party}: ${d.diff}`);
if (bigDiffs.length > 15) console.log(`    … and ${bigDiffs.length - 15} more`);
if (report.notes.length) {
  console.log("  Notes:");
  for (const n of report.notes) console.log(`    - ${n}`);
}
