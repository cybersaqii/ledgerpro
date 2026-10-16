"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Star, Search, Crown, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

const PRO_HREFS = new Set(["/reports/profit-loss", "/reports/balance-sheet", "/reports/journal", "/reports/tax-summary", "/reports/account-ledger", "/settings/chart-of-accounts"]);

const FAV_KEY = "ledgerpro:favReports";

type ReportDef = { key: string; num: string; bucket: string; href: string; title: string };

/** Category tabs (pill row), in display order — reuses the existing reportengine
 *  category strings so no new user-facing copy is introduced. */
const TABS = [
  { id: "favorites", bucket: null as string | null },
  { id: "bank", bucket: "catCashBank" },
  { id: "sales", bucket: "catSales" },
  { id: "purchases", bucket: "catPurchases" },
  { id: "parties", bucket: "catParties" },
  { id: "inventory", bucket: "catInventory" },
  { id: "financial", bucket: "catAccounting" },
  { id: "taxes", bucket: "catTaxPayroll" },
] as const;

export default function ReportsHub() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canAccounting = useCan("reports_accounting");
  const [isFree, setIsFree] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [activeTab, setActiveTab] = useState<string>("favorites");

  useEffect(() => {
    api<{ data: { level: string } }>("/api/billing/status")
      .then((d) => setIsFree(d.data.level === "FREE"))
      .catch(() => {});
    // Read from storage in an effect (not lazy init): localStorage does not
    // exist during SSR, and lazy init would hydrate stored favorites against
    // the server-rendered empty list.
    try {
      const raw = localStorage.getItem(FAV_KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate saved favorites after mount
      if (raw) setFavorites(JSON.parse(raw) as string[]);
    } catch {
      /* corrupted favorites — start empty */
    }
  }, []);

  function toggleFav(key: string) {
    setFavorites((f) => {
      const next = f.includes(key) ? f.filter((k) => k !== key) : [...f, key];
      try {
        localStorage.setItem(FAV_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — favorites live for this session only */
      }
      return next;
    });
  }

  const reports: ReportDef[] = [
    { key: "parametric", num: "001", bucket: "catAccounting", href: "/reports/builder", title: t("reportsindex.builder") },
    { key: "day-close", num: "002", bucket: "catAccounting", href: "/reports/day-close", title: t("reportsindex.dayClose") },
    { key: "trial-balance", num: "003", bucket: "catAccounting", href: "/reports/trial-balance", title: t("reportsindex.trialBalance") },
    { key: "account-ledger", num: "004", bucket: "catAccounting", href: "/reports/account-ledger", title: t("reportsindex.accountLedger") },
    { key: "chart-of-accounts", num: "005", bucket: "catAccounting", href: "/settings/chart-of-accounts", title: t("reportsindex.chartOfAccounts") },
    { key: "profit-loss", num: "006", bucket: "catAccounting", href: "/reports/profit-loss", title: t("reportsindex.profitLoss") },
    { key: "balance-sheet", num: "007", bucket: "catAccounting", href: "/reports/balance-sheet", title: t("reportsindex.balanceSheet") },
    { key: "journal", num: "008", bucket: "catAccounting", href: "/reports/journal", title: t("reportsindex.journal") },
    { key: "day-book", num: "009", bucket: "catAccounting", href: "/reports/day-book", title: t("reportsindex.dayBook") },
    { key: "bank-book", num: "010", bucket: "catCashBank", href: "/reports/bank-book", title: t("reportsindex.bankBook") },
    { key: "sale-summary", num: "011", bucket: "catSales", href: "/reports/sale-summary", title: t("reportsindex.saleSummary") },
    { key: "product-sales", num: "012", bucket: "catSales", href: "/reports/product-sales", title: t("fix4.psr.title") },
    { key: "purchase-summary", num: "013", bucket: "catPurchases", href: "/reports/purchase-summary", title: t("reportsindex.purchaseSummary") },
    { key: "party-ledger", num: "014", bucket: "catParties", href: "/reports/party-ledger", title: t("reportsindex.partyLedgerTitle", { party: bp.partyOne }) },
    { key: "receivables", num: "015", bucket: "catParties", href: "/reports/receivables", title: bp.receivables },
    { key: "payables", num: "016", bucket: "catParties", href: "/reports/payables", title: t("reportsindex.payables") },
    { key: "statements", num: "017", bucket: "catParties", href: "/reports/statements", title: t("reportsindex.statements", { party: bp.partyOne }) },
    { key: "stock", num: "018", bucket: "catInventory", href: "/stock", title: t("reportsindex.stockTitle", { stock: bp.stock }) },
    { key: "tax-summary", num: "019", bucket: "catTaxPayroll", href: "/reports/tax-summary", title: t("reportsindex.taxSummary") },
    { key: "out-of-stock", num: "020", bucket: "catInventory", href: "/reports/out-of-stock", title: t("reportsindex.outOfStock") },
    { key: "stock-movement", num: "021", bucket: "catInventory", href: "/reports/stock-movement", title: t("reportsindex.stockMovement") },
    { key: "bank-activity", num: "022", bucket: "catCashBank", href: "/reports/bank-activity", title: t("reportsindex.bankActivity") },
    { key: "sale-orders", num: "023", bucket: "catSales", href: "/reports/sale-orders", title: t("reportsindex.saleOrders") },
    { key: "quotations", num: "024", bucket: "catSales", href: "/reports/quotations", title: t("reportsindex.quotations") },
    { key: "unpaid-invoices", num: "025", bucket: "catSales", href: "/reports/unpaid-invoices", title: t("reportsindex.unpaidInvoices") },
    { key: "sale-recovery", num: "026", bucket: "catSales", href: "/reports/sale-recovery", title: t("reportsindex.saleRecovery") },
    { key: "supplier-payments", num: "027", bucket: "catPurchases", href: "/reports/supplier-payments", title: t("reportsindex.supplierPayments") },
    { key: "purchase-orders", num: "028", bucket: "catPurchases", href: "/reports/purchase-orders", title: t("reportsindex.purchaseOrders") },
    { key: "grn", num: "029", bucket: "catPurchases", href: "/reports/grn", title: t("reportsindex.grnReport") },
    { key: "asset-register", num: "030", bucket: "catAccounting", href: "/reports/asset-register", title: t("reportsindex.assetRegister") },
    { key: "depreciation", num: "031", bucket: "catAccounting", href: "/reports/depreciation", title: t("reportsindex.depreciation") },
    { key: "budget-vs-actual", num: "032", bucket: "catAccounting", href: "/reports/budget-vs-actual", title: t("reportsindex.budgetVsActual") },
    { key: "sales-data", num: "033", bucket: "catSales", href: "/reports/sales-data", title: t("reportsindex.salesData") },
    { key: "purchase-data", num: "034", bucket: "catPurchases", href: "/reports/purchase-data", title: t("reportsindex.purchaseData") },
    { key: "recovery-data", num: "035", bucket: "catSales", href: "/reports/recovery-data", title: t("reportsindex.recoveryData") },

  ];

  const visible = reports.filter((r) => canAccounting || !PRO_HREFS.has(r.href));
  const needle = q.trim().toLowerCase();
  const searched = needle
    ? visible.filter((r) => r.title.toLowerCase().includes(needle))
    : visible;

  const shown = activeTab === "favorites"
    ? searched.filter((r) => favorites.includes(r.key))
    : searched.filter((r) => r.bucket === TABS.find((tb) => tb.id === activeTab)?.bucket);

  function tabLabel(id: string): string {
    if (id === "favorites") return t("reportsindex.favorites");
    const tab = TABS.find((tb) => tb.id === id);
    return tab?.bucket ? t(`reportengine.${tab.bucket}`) : id;
  }

  function card(r: ReportDef) {
    const locked = isFree && PRO_HREFS.has(r.href);
    const starred = favorites.includes(r.key);
    return (
      <div key={r.key} className="card group flex items-center gap-3 p-4 transition hover:shadow-md">
        <Link
          href={r.href}
          aria-label={r.title}
          className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-[#1d9bd7] text-base font-extrabold tracking-wide text-white transition group-hover:scale-105"
        >
          {r.num}
        </Link>
        <Link href={r.href} className="min-w-0 flex-1 truncate text-sm font-bold text-foreground transition group-hover:text-primary">
          {r.title}
          {locked && (
            <span className="ms-2 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2 py-0.5 align-middle text-[0.68rem] font-bold text-accent">
              <Crown size={10} /> PRO
            </span>
          )}
        </Link>
        <button
          type="button"
          aria-label={t("reportsindex.favToggle")}
          aria-pressed={starred}
          onClick={() => toggleFav(r.key)}
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-full transition ${
            starred ? "text-accent" : "text-muted-foreground/40 hover:text-accent"
          }`}
        >
          <Star size={18} fill={starred ? "currentColor" : "none"} />
        </button>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={t("reportsindex.title")}
        subtitle={t("reportsindex.subtitle")}
        icon={<BarChart3 size={20} />}
        actions={
          <div className="relative">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              className="field !w-56 !py-2 !ps-9 !text-xs"
              placeholder={t("reportsindex.searchPh")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label={t("reportsindex.searchPh")}
            />
          </div>
        }
      />

      {/* Category tabs */}
      <div className="mb-4 flex gap-2 overflow-x-auto pb-1" role="tablist" aria-label={t("reportsindex.title")}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`shrink-0 rounded-full px-4 py-2 text-sm font-bold transition ${
              activeTab === tab.id
                ? "bg-primary text-white shadow-sm"
                : "bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground"
            }`}
          >
            {tabLabel(tab.id)}
          </button>
        ))}
      </div>

      {/* Report cards — 2-column grid (FA style), 1 column on phones */}
      {shown.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {shown.map(card)}
        </div>
      ) : (
        <p className="card mt-2 px-6 py-10 text-center text-sm text-muted-foreground">
          {activeTab === "favorites" && !needle
            ? t("reportsindex.noFavs")
            : t("reportsindex.noMatch")}
        </p>
      )}
    </div>
  );
}
