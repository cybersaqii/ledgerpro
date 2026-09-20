"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Scale, TrendingUp, Landmark, BookOpen, ArrowDownToLine, ArrowUpFromLine, Boxes, BarChart3, ScrollText, Crown } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";
import { api } from "@/lib/format";

const PRO_HREFS = new Set(["/reports/profit-loss", "/reports/balance-sheet", "/reports/journal"]);

export default function ReportsHub() {
  const bp = useBusinessProfile();
  const [isFree, setIsFree] = useState(false);
  useEffect(() => {
    api<{ data: { level: string } }>("/api/billing/status")
      .then((d) => setIsFree(d.data.level === "FREE"))
      .catch(() => {});
  }, []);
  const reports = [
    { href: "/reports/trial-balance", icon: Scale, title: "Trial balance", text: "Every account's debits & credits. Always balanced." },
    { href: "/reports/profit-loss", icon: TrendingUp, title: "Profit & loss", text: `${bp.salesNav}, costs, expenses and net profit for any period.` },
    { href: "/reports/balance-sheet", icon: Landmark, title: "Balance sheet", text: "Assets, liabilities and equity — your business net worth." },
    { href: "/reports/party-ledger", icon: BookOpen, title: `${bp.partyOne} ledger`, text: `Full transaction history of any ${bp.partyOne.toLowerCase()} or supplier.` },
    { href: "/reports/receivables", icon: ArrowDownToLine, title: bp.receivables, text: `Who owes you money, and how much.` },
    { href: "/reports/payables", icon: ArrowUpFromLine, title: "Payables", text: "Who you owe money to, and how much." },
    { href: "/reports/journal", icon: ScrollText, title: "Journal", text: "The audit trail — every balanced entry behind your books." },
    { href: "/stock", icon: Boxes, title: `${bp.stock} report`, text: `Quantities, average cost and value of every ${bp.productOne.toLowerCase()}.` },
  ];
  return (
    <div>
      <PageHeader title="Reports" subtitle="Every number in your business, explained" icon={<BarChart3 size={20} />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((r, i) => {
          const locked = isFree && PRO_HREFS.has(r.href);
          return (
            <Link key={r.href} href={r.href} className={`card card-gloss rise rise-${(i % 4) + 1} group relative p-6 transition hover:-translate-y-0.5`}>
              {locked && (
                <span className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 dark:bg-amber-900/40 dark:text-amber-200">
                  <Crown size={12} /> PRO
                </span>
              )}
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary transition group-hover:scale-110">
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
