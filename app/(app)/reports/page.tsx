"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Scale, TrendingUp, Landmark, BookOpen, ArrowDownToLine, ArrowUpFromLine, Boxes, BarChart3, ScrollText, Crown, Sunrise } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

const PRO_HREFS = new Set(["/reports/profit-loss", "/reports/balance-sheet", "/reports/journal"]);

export default function ReportsHub() {
  const bp = useBusinessProfile();
  const { t } = useLang();
  const canAccounting = useCan("reports_accounting");
  const [isFree, setIsFree] = useState(false);
  useEffect(() => {
    api<{ data: { level: string } }>("/api/billing/status")
      .then((d) => setIsFree(d.data.level === "FREE"))
      .catch(() => {});
  }, []);
  const reports = [
    { href: "/reports/day-close", icon: Sunrise, title: t("reportsindex.dayClose"), text: t("reportsindex.dayCloseText") },
    { href: "/reports/trial-balance", icon: Scale, title: t("reportsindex.trialBalance"), text: t("reportsindex.trialBalanceText") },
    { href: "/reports/profit-loss", icon: TrendingUp, title: t("reportsindex.profitLoss"), text: t("reportsindex.profitLossText", { sales: bp.salesNav }) },
    { href: "/reports/balance-sheet", icon: Landmark, title: t("reportsindex.balanceSheet"), text: t("reportsindex.balanceSheetText") },
    { href: "/reports/party-ledger", icon: BookOpen, title: t("reportsindex.partyLedgerTitle", { party: bp.partyOne }), text: t("reportsindex.partyLedgerText", { party: bp.partyOne.toLowerCase() }) },
    { href: "/reports/receivables", icon: ArrowDownToLine, title: bp.receivables, text: t("reportsindex.receivablesText") },
    { href: "/reports/payables", icon: ArrowUpFromLine, title: t("reportsindex.payables"), text: t("reportsindex.payablesText") },
    { href: "/reports/journal", icon: ScrollText, title: t("reportsindex.journal"), text: t("reportsindex.journalText") },
    { href: "/stock", icon: Boxes, title: t("reportsindex.stockTitle", { stock: bp.stock }), text: t("reportsindex.stockText", { product: bp.productOne.toLowerCase() }) },
  ];
  return (
    <div>
      <PageHeader title={t("reportsindex.title")} subtitle={t("reportsindex.subtitle")} icon={<BarChart3 size={20} />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reports
          .filter((r) => canAccounting || !PRO_HREFS.has(r.href))
          .map((r, i) => {
          const locked = isFree && PRO_HREFS.has(r.href);
          return (
            <Link key={r.href} href={r.href} className={`card card-gloss card-lift rise rise-${(i % 4) + 1} group relative p-6`}>
              {locked && (
                <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-gradient-to-r from-amber-100 to-orange-100 px-2.5 py-1 text-xs font-bold text-amber-800 shadow-sm dark:from-amber-900/50 dark:to-orange-900/50 dark:text-amber-200">
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
        })}
      </div>
    </div>
  );
}
