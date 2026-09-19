"use client";

import Link from "next/link";
import { Scale, TrendingUp, Landmark, BookOpen, ArrowDownToLine, ArrowUpFromLine, Boxes, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useBusinessProfile } from "@/components/business-type";

export default function ReportsHub() {
  const bp = useBusinessProfile();
  const reports = [
    { href: "/reports/trial-balance", icon: Scale, title: "Trial balance", text: "Every account's debits & credits. Always balanced." },
    { href: "/reports/profit-loss", icon: TrendingUp, title: "Profit & loss", text: `${bp.salesNav}, costs, expenses and net profit for any period.` },
    { href: "/reports/balance-sheet", icon: Landmark, title: "Balance sheet", text: "Assets, liabilities and equity — your business net worth." },
    { href: "/reports/party-ledger", icon: BookOpen, title: `${bp.partyOne} ledger`, text: `Full transaction history of any ${bp.partyOne.toLowerCase()} or supplier.` },
    { href: "/reports/receivables", icon: ArrowDownToLine, title: bp.receivables, text: `Who owes you money, and how much.` },
    { href: "/reports/payables", icon: ArrowUpFromLine, title: "Payables", text: "Who you owe money to, and how much." },
    { href: "/stock", icon: Boxes, title: `${bp.stock} report`, text: `Quantities, average cost and value of every ${bp.productOne.toLowerCase()}.` },
  ];
  return (
    <div>
      <PageHeader title="Reports" subtitle="Every number in your business, explained" icon={<BarChart3 size={20} />} />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {reports.map((r, i) => (
          <Link key={r.href} href={r.href} className={`card card-gloss rise rise-${(i % 4) + 1} group p-6 transition hover:-translate-y-0.5`}>
            <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary transition group-hover:scale-110">
              <r.icon size={22} />
            </span>
            <h3 className="mt-4 text-base font-bold">{r.title}</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{r.text}</p>
          </Link>
        ))}
      </div>
    </div>
  );
}
