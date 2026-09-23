"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Scale, TrendingUp, Landmark, BookOpen, ArrowDownToLine, ArrowUpFromLine, Boxes, BarChart3, ScrollText, Crown, Sunrise, Star, Search, FileText, ClipboardList, ClipboardCheck, Wallet, CalendarDays, Percent } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

const PRO_HREFS = new Set(["/reports/profit-loss", "/reports/balance-sheet", "/reports/journal", "/reports/tax-summary"]);

type ReportDef = { key: string; href: string; icon: typeof Scale; title: string; text: string };

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
    { key: "day-close", href: "/reports/day-close", icon: Sunrise, title: t("reportsindex.dayClose"), text: t("reportsindex.dayCloseText") },
    { key: "trial-balance", href: "/reports/trial-balance", icon: Scale, title: t("reportsindex.trialBalance"), text: t("reportsindex.trialBalanceText") },
    { key: "profit-loss", href: "/reports/profit-loss", icon: TrendingUp, title: t("reportsindex.profitLoss"), text: t("reportsindex.profitLossText", { sales: bp.salesNav }) },
    { key: "balance-sheet", href: "/reports/balance-sheet", icon: Landmark, title: t("reportsindex.balanceSheet"), text: t("reportsindex.balanceSheetText") },
    { key: "party-ledger", href: "/reports/party-ledger", icon: BookOpen, title: t("reportsindex.partyLedgerTitle", { party: bp.partyOne }), text: t("reportsindex.partyLedgerText", { party: bp.partyOne.toLowerCase() }) },
    { key: "receivables", href: "/reports/receivables", icon: ArrowDownToLine, title: bp.receivables, text: t("reportsindex.receivablesText") },
    { key: "payables", href: "/reports/payables", icon: ArrowUpFromLine, title: t("reportsindex.payables"), text: t("reportsindex.payablesText") },
    { key: "journal", href: "/reports/journal", icon: ScrollText, title: t("reportsindex.journal"), text: t("reportsindex.journalText") },
    { key: "stock", href: "/stock", icon: Boxes, title: t("reportsindex.stockTitle", { stock: bp.stock }), text: t("reportsindex.stockText", { product: bp.productOne.toLowerCase() }) },
    { key: "statements", href: "/reports/statements", icon: FileText, title: t("reportsindex.statements", { party: bp.partyOne }), text: t("reportsindex.statementsText", { party: bp.partyOne.toLowerCase() }) },
    { key: "sale-summary", href: "/reports/sale-summary", icon: ClipboardList, title: t("reportsindex.saleSummary"), text: t("reportsindex.saleSummaryText", { parties: bp.partyMany.toLowerCase() }) },
    { key: "purchase-summary", href: "/reports/purchase-summary", icon: ClipboardCheck, title: t("reportsindex.purchaseSummary"), text: t("reportsindex.purchaseSummaryText") },
    { key: "bank-book", href: "/reports/bank-book", icon: Wallet, title: t("reportsindex.bankBook"), text: t("reportsindex.bankBookText") },
    { key: "day-book", href: "/reports/day-book", icon: CalendarDays, title: t("reportsindex.dayBook"), text: t("reportsindex.dayBookText") },
    { key: "tax-summary", href: "/reports/tax-summary", icon: Percent, title: t("reportsindex.taxSummary"), text: t("reportsindex.taxSummaryText") },
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
      <Link key={r.href} href={r.href} className={`card card-gloss card-lift rise rise-${(i % 4) + 1} group relative p-6`}>
        <button
          type="button"
          aria-label={t("reportsindex.favToggle")}
          aria-pressed={starred}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); toggleFav(r.key); }}
          className={`absolute right-4 top-4 rounded-full p-1.5 transition ${starred ? "text-amber-500" : "text-muted-foreground/40 hover:text-amber-500"}`}
        >
          <Star size={17} fill={starred ? "currentColor" : "none"} />
        </button>
        {locked && (
          <span className="absolute right-4 top-12 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-100 to-orange-100 px-2.5 py-1 text-xs font-bold text-amber-800 shadow-sm dark:from-amber-900/50 dark:to-orange-900/50 dark:text-amber-200">
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

  return (
    <div>
      <PageHeader title={t("reportsindex.title")} subtitle={t("reportsindex.subtitle")} icon={<BarChart3 size={20} />} />
      <div className="relative mb-5">
        <Search size={17} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
        <input
          className="field !pl-10"
          placeholder={t("reportsindex.searchPh")}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label={t("reportsindex.searchPh")}
        />
      </div>
      {favList.length > 0 && (
        <div className="mb-8">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">
            <Star size={14} className="text-amber-500" fill="currentColor" /> {t("reportsindex.favorites")}
          </h2>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {favList.map((r, i) => card(r, i))}
          </div>
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rest.map((r, i) => card(r, i))}
      </div>
      {searched.length === 0 && (
        <p className="card mt-2 px-6 py-10 text-center text-sm text-muted-foreground">{t("reportsindex.noMatch")}</p>
      )}
    </div>
  );
}
