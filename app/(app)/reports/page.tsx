"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Scale, TrendingUp, Landmark, BookOpen, ArrowDownToLine, ArrowUpFromLine, Boxes, BarChart3, ScrollText, Crown, Sunrise, Star, Search, FileText, ClipboardList, ClipboardCheck, Wallet, CalendarDays, Percent, Package, ListTree, BookMarked, SlidersHorizontal } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

const PRO_HREFS = new Set(["/reports/profit-loss", "/reports/balance-sheet", "/reports/journal", "/reports/tax-summary", "/reports/account-ledger", "/settings/chart-of-accounts"]);

type ReportDef = { key: string; href: string; icon: typeof Scale; title: string; text: string; bucket: string };

/** Buckets in display order — titles reuse the existing reportengine category
 *  strings so no new user-facing copy is introduced. */
const BUCKETS = [
  "catAccounting",
  "catSales",
  "catPurchases",
  "catParties",
  "catInventory",
  "catCashBank",
  "catTaxPayroll",
] as const;

export default function ReportsHub() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canAccounting = useCan("reports_accounting");
  const [isFree, setIsFree] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    api<{ data: { level: string } }>("/api/billing/status")
      .then((d) => setIsFree(d.data.level === "FREE"))
      .catch(() => {});
    api<{ data: string[] }>("/api/reports/favorites")
      .then((d) => setFavorites(d.data))
      .catch(() => {});
  }, []);

  async function toggleFav(key: string) {
    const on = favorites.includes(key);
    setFavorites((f) => (on ? f.filter((k) => k !== key) : [...f, key]));
    try {
      if (on) await api(`/api/reports/favorites?reportKey=${encodeURIComponent(key)}`, { method: "DELETE" });
      else await api("/api/reports/favorites", { method: "POST", body: JSON.stringify({ reportKey: key }) });
    } catch {
      // revert on failure
      setFavorites((f) => (on ? [...f, key] : f.filter((k) => k !== key)));
    }
  }

  const reports: ReportDef[] = [
    { key: "parametric", bucket: "catAccounting", href: "/reports/builder", icon: SlidersHorizontal, title: t("reportsindex.builder"), text: t("reportsindex.builderText") },
    { key: "day-close", bucket: "catAccounting", href: "/reports/day-close", icon: Sunrise, title: t("reportsindex.dayClose"), text: t("reportsindex.dayCloseText") },
    { key: "trial-balance", bucket: "catAccounting", href: "/reports/trial-balance", icon: Scale, title: t("reportsindex.trialBalance"), text: t("reportsindex.trialBalanceText") },
    { key: "account-ledger", bucket: "catAccounting", href: "/reports/account-ledger", icon: BookMarked, title: t("reportsindex.accountLedger"), text: t("reportsindex.accountLedgerText") },
    { key: "chart-of-accounts", bucket: "catAccounting", href: "/settings/chart-of-accounts", icon: ListTree, title: t("reportsindex.chartOfAccounts"), text: t("reportsindex.chartOfAccountsText") },
    { key: "profit-loss", bucket: "catAccounting", href: "/reports/profit-loss", icon: TrendingUp, title: t("reportsindex.profitLoss"), text: t("reportsindex.profitLossText", { sales: bp.salesNav }) },
    { key: "balance-sheet", bucket: "catAccounting", href: "/reports/balance-sheet", icon: Landmark, title: t("reportsindex.balanceSheet"), text: t("reportsindex.balanceSheetText") },
    { key: "party-ledger", bucket: "catParties", href: "/reports/party-ledger", icon: BookOpen, title: t("reportsindex.partyLedgerTitle", { party: bp.partyOne }), text: t("reportsindex.partyLedgerText", { party: bp.partyOne.toLowerCase() }) },
    { key: "receivables", bucket: "catParties", href: "/reports/receivables", icon: ArrowDownToLine, title: bp.receivables, text: t("reportsindex.receivablesText") },
    { key: "payables", bucket: "catParties", href: "/reports/payables", icon: ArrowUpFromLine, title: t("reportsindex.payables"), text: t("reportsindex.payablesText") },
    { key: "journal", bucket: "catAccounting", href: "/reports/journal", icon: ScrollText, title: t("reportsindex.journal"), text: t("reportsindex.journalText") },
    { key: "stock", bucket: "catInventory", href: "/stock", icon: Boxes, title: t("reportsindex.stockTitle", { stock: bp.stock }), text: t("reportsindex.stockText", { product: bp.productOne.toLowerCase() }) },
    { key: "statements", bucket: "catParties", href: "/reports/statements", icon: FileText, title: t("reportsindex.statements", { party: bp.partyOne }), text: t("reportsindex.statementsText", { party: bp.partyOne.toLowerCase() }) },
    { key: "sale-summary", bucket: "catSales", href: "/reports/sale-summary", icon: ClipboardList, title: t("reportsindex.saleSummary"), text: t("reportsindex.saleSummaryText", { parties: bp.partyMany.toLowerCase() }) },
    { key: "purchase-summary", bucket: "catPurchases", href: "/reports/purchase-summary", icon: ClipboardCheck, title: t("reportsindex.purchaseSummary"), text: t("reportsindex.purchaseSummaryText") },
    { key: "product-sales", bucket: "catSales", href: "/reports/product-sales", icon: Package, title: t("fix4.psr.title"), text: t("fix4.psr.galleryText") },
    { key: "bank-book", bucket: "catCashBank", href: "/reports/bank-book", icon: Wallet, title: t("reportsindex.bankBook"), text: t("reportsindex.bankBookText") },
    { key: "day-book", bucket: "catAccounting", href: "/reports/day-book", icon: CalendarDays, title: t("reportsindex.dayBook"), text: t("reportsindex.dayBookText") },
    { key: "tax-summary", bucket: "catTaxPayroll", href: "/reports/tax-summary", icon: Percent, title: t("reportsindex.taxSummary"), text: t("reportsindex.taxSummaryText") },
  ];

  const visible = reports.filter((r) => canAccounting || !PRO_HREFS.has(r.href));
  const needle = q.trim().toLowerCase();
  const searched = needle
    ? visible.filter((r) => `${r.title} ${r.text}`.toLowerCase().includes(needle))
    : visible;
  const favList = searched.filter((r) => favorites.includes(r.key));
  const rest = searched.filter((r) => !favorites.includes(r.key));

  function card(r: ReportDef, i: number) {
    const locked = isFree && PRO_HREFS.has(r.href);
    const starred = favorites.includes(r.key);
    return (
      <Link key={r.href} href={r.href} className={`card card-lift rise rise-${(i % 4) + 1} group relative p-6`}>
        <button
          type="button"
          aria-label={t("reportsindex.favToggle")}
          aria-pressed={starred}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(r.key); }}
          className={`absolute end-4 top-4 grid h-11 w-11 place-items-center rounded-full transition ${starred ? "text-accent" : "text-muted-foreground/40 hover:text-accent"}`}
        >
          <Star size={17} fill={starred ? "currentColor" : "none"} />
        </button>
        {locked && (
          <span className="absolute end-4 top-14 inline-flex items-center gap-1 rounded-full border border-accent/30 bg-accent-soft px-2.5 py-1 text-xs font-bold text-accent">
            <Crown size={12} /> PRO
          </span>
        )}
        <span className="tile tile-primary h-12 w-12 transition group-hover:scale-110">
          <r.icon size={22} />
        </span>
        <h3 className="mt-4 text-base font-bold">{r.title}</h3>
        <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{r.text}</p>
      </Link>
    );
  }

  const [activeBucket, setActiveBucket] = useState<string>("all");

  // Filter by active bucket + search
  const bucketFiltered = activeBucket === "all"
    ? searched
    : activeBucket === "favorites"
      ? favList
      : searched.filter((r) => r.bucket === activeBucket);
  const showFavs = activeBucket === "all" || activeBucket === "favorites";
  const displayFavs = showFavs ? favList : [];
  const displayRest = activeBucket === "favorites" ? [] : bucketFiltered.filter((r) => !favorites.includes(r.key));

  // Category counts for the sidebar
  const bucketCount = (b: string) => searched.filter((r) => r.bucket === b).length;

  return (
    <div>
      <PageHeader title={t("reportsindex.title")} subtitle={t("reportsindex.subtitle")} icon={<BarChart3 size={20} />} />
      <div className="relative mb-5">
        <Search size={17} className="absolute start-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          className="field !ps-10"
          placeholder={t("reportsindex.searchPh")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("reportsindex.searchPh")}
        />
      </div>
      <div className="flex flex-col gap-6 lg:flex-row">
        {/* Category sidebar */}
        <aside className="w-full shrink-0 lg:w-56">
          <nav className="card flex flex-row gap-1 overflow-x-auto p-2 lg:flex-col" aria-label={t("reportsindex.title")}>
            <button
              type="button"
              onClick={() => setActiveBucket("favorites")}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                activeBucket === "favorites" ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <Star size={16} className={activeBucket === "favorites" ? "text-accent" : ""} fill={activeBucket === "favorites" ? "currentColor" : "none"} />
              {t("reportsindex.favorites")}
              <span className="ms-auto rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{favList.length}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveBucket("all")}
              className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                activeBucket === "all" ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <BarChart3 size={16} />
              {t("common.all")}
            </button>
            {BUCKETS.map((b) => {
              const count = bucketCount(b);
              if (count === 0 && needle) return null;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => setActiveBucket(b)}
                  className={`flex shrink-0 items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-sm font-semibold transition ${
                    activeBucket === b ? "bg-primary-soft text-primary" : "text-muted-foreground hover:bg-muted hover:text-foreground"
                  }`}
                >
                  {t(`reportengine.${b}`)}
                  <span className="ms-auto rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{count}</span>
                </button>
              );
            })}
          </nav>
        </aside>
        {/* Report cards */}
        <div className="min-w-0 flex-1">
          {displayFavs.length > 0 && activeBucket !== "favorites" && (
            <div className="mb-6">
              <h2 className="mb-3 flex items-center gap-2 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">
                <Star size={14} className="text-accent" fill="currentColor" /> {t("reportsindex.favorites")}
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {displayFavs.map((r, i) => card(r, i))}
              </div>
            </div>
          )}
          {(activeBucket === "favorites" ? displayFavs : displayRest).length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {(activeBucket === "favorites" ? displayFavs : displayRest).map((r, i) => card(r, i))}
            </div>
          ) : (
            activeBucket !== "all" || searched.length === 0 ? (
              <p className="card mt-2 px-6 py-10 text-center text-sm text-muted-foreground">{t("reportsindex.noMatch")}</p>
            ) : null
          )}
        </div>
      </div>
    </div>
  );
}
