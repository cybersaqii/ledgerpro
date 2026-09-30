"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Boxes } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { api, fmtMoney, fmtDate, fmtQty, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { fx } from "@/components/fix3-lang";

type Line = {
  id: string; productId: string; qtyMilli: string; costPaisa: string;
  productName: string; sku: string; unit: string;
};
type Adj = {
  id: string; docNo: string; date: number; reason: string; notes: string | null;
  journalEntryId: string | null; lines: Line[];
};

function reasonLabel(f: (k: string) => string, r: string): string {
  return f(`fix3.adjReason${r.charAt(0)}${r.slice(1).toLowerCase()}`);
}

export default function AdjustmentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => fx(t, k, vars);
  const [adj, setAdj] = useState<Adj | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    params.then((p) =>
      api<{ data: Adj }>(`/api/stock-adjustments/${p.id}`)
        .then((d) => setAdj(d.data))
        .catch(() => setError("Not found."))
    );
  }, [params]);

  if (error || !adj) {
    return (
      <PageHeader title={f("fix3.adjDetail")}
        subtitle={error ?? ""}
        actions={<Link href="/stock/adjustments" className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("common.back")}</Link>} />
    );
  }

  const loss = adj.lines.filter((l) => toBig(l.qtyMilli) < 0n);
  const gain = adj.lines.filter((l) => toBig(l.qtyMilli) > 0n);
  const value = (ls: Line[]) =>
    ls.reduce((a, l) => {
      const q = toBig(l.qtyMilli) < 0n ? -toBig(l.qtyMilli) : toBig(l.qtyMilli);
      return a + ((q * toBig(l.costPaisa) + 500n) / 1000n);
    }, 0n);

  return (
    <div>
      <PageHeader
        title={`${f("fix3.adjDetail")} ${adj.docNo}`}
        subtitle={fmtDate(adj.date)}
        icon={<Boxes size={20} />}
        actions={<Link href="/stock/adjustments" className="btn btn-ghost text-sm"><ArrowLeft size={15} /> {t("common.back")}</Link>}
      />

      <div className="card rise p-5 sm:p-6">
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">{f("fix3.adjReason")}</dt><dd className="font-bold">{reasonLabel(f, adj.reason)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{f("fix3.adjColValue")} ({f("fix3.adjOut")})</dt><dd className="font-bold text-danger">{fmtMoney(value(loss))}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{f("fix3.adjColValue")} ({f("fix3.adjIn")})</dt><dd className="font-bold text-primary">{fmtMoney(value(gain))}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t("common.view")}</dt>
            <dd className="font-bold">{adj.journalEntryId ? (
              <Link href={`/reports/journal`} className="text-primary hover:underline">{adj.docNo}</Link>
            ) : "—"}</dd></div>
        </dl>
        {adj.notes && <p className="mt-3 text-sm text-muted-foreground">{adj.notes}</p>}
      </div>

      <div className="card rise rise-1 mt-5 p-5 sm:p-6">
        <h2 className="font-extrabold">{f("fix3.adjLines")}</h2>
        <div className="mt-3 overflow-x-auto">
          <table className="tbl">
            <thead><tr>
              <th>{f("fix3.adjColProduct")}</th><th className="num">{f("fix3.adjColQty")}</th>
              <th className="num">{f("fix3.adjColCost")}</th><th className="num">{f("fix3.adjColLineValue")}</th>
            </tr></thead>
            <tbody>
              {adj.lines.map((l) => {
                const out = toBig(l.qtyMilli) < 0n;
                return (
                  <tr key={l.id}>
                    <td><span className="font-bold">{l.productName}</span> <span className="text-xs text-muted-foreground">{l.sku}</span></td>
                    <td className={`num font-bold ${out ? "text-danger" : "text-primary"}`}>
                      {out ? "−" : "+"}{fmtQty(toBig(l.qtyMilli) < 0n ? -toBig(l.qtyMilli) : toBig(l.qtyMilli), l.unit)}
                    </td>
                    <td className="num">{fmtMoney(l.costPaisa)}</td>
                    <td className="num font-bold">{fmtMoney(((toBig(l.qtyMilli) < 0n ? -toBig(l.qtyMilli) : toBig(l.qtyMilli)) * toBig(l.costPaisa) + 500n) / 1000n)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
