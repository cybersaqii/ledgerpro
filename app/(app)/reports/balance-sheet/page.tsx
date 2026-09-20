"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert } from "lucide-react";
import { PageHeader, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Line = { label: string; amount: string; bold?: boolean; total?: boolean };

function Section({ title, lines }: { title: string; lines: Line[] }) {
  return (
    <div className="card p-6">
      <h2 className="text-base font-extrabold tracking-tight">{title}</h2>
      <div className="mt-2">
        {lines.map((l) => (
          <div key={l.label} className={`flex items-center justify-between py-2 ${l.total ? "border-t-2 border-border pt-3" : "border-b border-border/60"}`}>
            <span className={l.bold ? "font-extrabold" : "text-muted-foreground"}>{l.label}</span>
            <span className={`num font-bold ${l.total ? "text-lg text-primary" : ""}`}>{fmtMoney(l.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BalanceSheetPage() {
  const { t } = useLang();
  const [data, setData] = useState<{ assets: Line[]; liabilities: Line[]; equity: Line[]; balanced: boolean } | null>(null);

  useEffect(() => {
    api<{ assets: Line[]; liabilities: Line[]; equity: Line[]; balanced: boolean }>("/api/reports/balance-sheet")
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) return <div><PageHeader title={t("balancesheet.title")} subtitle={t("common.loading")} /><div className="card h-64 animate-pulse" /></div>;

  return (
    <div>
      <PageHeader
        title={t("balancesheet.title")}
        subtitle={t("balancesheet.subtitle")}
        actions={<>
          {data.balanced
            ? <span className="badge bg-primary-soft text-primary !text-xs !py-1.5 !px-3"><CheckCircle2 size={13} /> {t("balancesheet.balanced")}</span>
            : <span className="badge bg-danger-soft text-danger !text-xs !py-1.5 !px-3"><TriangleAlert size={13} /> {t("balancesheet.outOfBalance")}</span>}
          <ExportCsv filename="balance-sheet" rows={() => [
            [t("balancesheet.csvSection"), t("balancesheet.csvAccount"), t("balancesheet.csvAmount")],
            ...data.assets.map((l) => [t("balancesheet.assets"), l.label, csvMoney(l.amount)]),
            ...data.liabilities.map((l) => [t("balancesheet.liabilities"), l.label, csvMoney(l.amount)]),
            ...data.equity.map((l) => [t("balancesheet.equity"), l.label, csvMoney(l.amount)]),
          ]} />
        </>}
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title={t("balancesheet.assets")} lines={data.assets} />
        <Section title={t("balancesheet.liabilities")} lines={data.liabilities} />
        <Section title={t("balancesheet.equity")} lines={data.equity} />
      </div>
    </div>
  );
}
