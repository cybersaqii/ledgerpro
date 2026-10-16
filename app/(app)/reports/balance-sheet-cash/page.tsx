"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, TriangleAlert, Banknote } from "lucide-react";
import { PageHeader, ExportCsv } from "@/components/ui";
import { csvMoney } from "@/lib/csv";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Line = { label: string; amount: string; bold?: boolean; total?: boolean; sign?: number };

function Section({ title, lines, t }: { title: string; lines: Line[]; t: (key: string) => string }) {
  return (
    <div className="card p-6">
      <h2 className="text-base font-extrabold tracking-tight">{title}</h2>
      <div className="mt-2">
        {lines.map((l) => (
          <div key={l.label} className={`flex items-center justify-between py-2 ${l.total ? "border-t-2 border-border pt-3" : "border-b border-border/60"}`}>
            <span className={l.bold ? "font-extrabold" : "text-muted-foreground"}>{t(l.label)}</span>
            <span className={`num font-bold ${l.total ? "text-lg text-primary" : ""}`}>{fmtMoney(l.amount)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function BalanceSheetCashPage() {
  const { t } = useLang();
  const [data, setData] = useState<{
    assets: Line[]; liabilities: Line[]; equity: Line[];
    balanced: boolean; cashInOut?: { in: string; out: string };
  } | null>(null);

  useEffect(() => {
    api<{ assets: Line[]; liabilities: Line[]; equity: Line[]; balanced: boolean; cashInOut?: { in: string; out: string } }>("/api/reports/balance-sheet-cash")
      .then(setData)
      .catch(() => {});
  }, []);

  if (!data) return <div><PageHeader title={t("bscash.title")} subtitle={t("common.loading")} icon={<Banknote size={20} />} /><div className="card h-64 animate-pulse" /></div>;

  return (
    <div>
      <PageHeader
        title={t("bscash.title")}
        subtitle={t("bscash.subtitle")}
        icon={<Banknote size={20} />}
        actions={<>
          {data.balanced
            ? <span className="badge bg-primary-soft text-primary !text-xs !py-1.5 !px-3"><CheckCircle2 size={13} /> {t("bscash.balanced")}</span>
            : <span className="badge bg-danger-soft text-danger !text-xs !py-1.5 !px-3"><TriangleAlert size={13} /> {t("bscash.outOfBalance")}</span>}
          <ExportCsv filename="balance-sheet-cash" rows={() => [
            [t("bscash.csvSection"), t("bscash.csvAccount"), t("bscash.csvAmount")],
            ...data.assets.map((l) => [t("bscash.assets"), t(l.label), csvMoney(l.amount)]),
            ...data.liabilities.map((l) => [t("bscash.liabilities"), t(l.label), csvMoney(l.amount)]),
            ...data.equity.map((l) => [t("bscash.equity"), t(l.label), csvMoney(l.amount)]),
          ]} />
        </>}
      />
      {data.cashInOut && (
        <div className="mb-4 grid grid-cols-2 gap-3">
          <div className="card !p-4">
            <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("bscash.allTimeIn")}</p>
            <p className="mt-1 text-lg font-extrabold tabular-nums text-success">{fmtMoney(data.cashInOut.in)}</p>
          </div>
          <div className="card !p-4">
            <p className="text-[0.7rem] font-bold uppercase tracking-wide text-muted-foreground">{t("bscash.allTimeOut")}</p>
            <p className="mt-1 text-lg font-extrabold tabular-nums text-danger">{fmtMoney(data.cashInOut.out)}</p>
          </div>
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-3">
        <Section title={t("bscash.assets")} lines={data.assets} t={t} />
        <Section title={t("bscash.liabilities")} lines={data.liabilities} t={t} />
        <Section title={t("bscash.equity")} lines={data.equity} t={t} />
      </div>
      <p className="mt-4 text-xs text-muted-foreground">{t("bscash.note")}</p>
    </div>
  );
}
