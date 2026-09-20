"use client";

import { useEffect, useState } from "react";
import { Sunrise, TrendingUp, ArrowDownToLine, ArrowUpFromLine, Receipt, Wallet, ShoppingCart, Undo2, PiggyBank } from "lucide-react";
import { PageHeader, ExportCsv, SummaryChips, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { csvMoney } from "@/lib/csv";
import { useLang } from "@/components/lang-provider";

type Bucket = { count: number; total: string };
type Data = {
  date: string;
  sales: Bucket;
  salesReturns: Bucket;
  purchases: Bucket;
  purchaseReturns: Bucket;
  receipts: Bucket;
  paymentsMade: Bucket;
  expenses: Bucket & { byAccount: { account: string; total: string }[] };
  cashIn: string;
  cashOut: string;
  netCash: string;
  netSales: string;
};

export default function DayClosePage() {
  const { t } = useLang();
  const [date, setDate] = useState(fmtDateInput());
  const [d, setD] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const r = await api<Data>(`/api/reports/day-close?date=${date}`);
        if (!cancelled) setD(r);
      } catch { if (!cancelled) setD(null); } finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [date]);

  const net = d ? BigInt(d.netCash) : 0n;

  return (
    <div>
      <PageHeader
        title={t("dayclose.title")}
        subtitle={t("dayclose.subtitle")}
        icon={<Sunrise size={20} />}
        actions={
          <ExportCsv filename={`day-close-${d?.date ?? date}`} disabled={loading || !d} rows={() => d ? [
            [t("dayclose.csvTitle"), d.date],
            ["", ""],
            [t("dayclose.csvItem"), t("dayclose.csvCount"), t("dayclose.csvAmount")],
            [t("dayclose.cardSales"), d.sales.count, csvMoney(d.sales.total)],
            [t("dayclose.cardSalesReturns"), d.salesReturns.count, csvMoney(d.salesReturns.total)],
            [t("dayclose.csvNetSales"), "", csvMoney(d.netSales)],
            [t("dayclose.cardPurchases"), d.purchases.count, csvMoney(d.purchases.total)],
            [t("dayclose.csvPurchaseReturns"), d.purchaseReturns.count, csvMoney(d.purchaseReturns.total)],
            [t("dayclose.cardCashReceived"), d.receipts.count, csvMoney(d.receipts.total)],
            [t("dayclose.cardCashPaid"), d.paymentsMade.count, csvMoney(d.paymentsMade.total)],
            [t("dayclose.cardExpenses"), d.expenses.count, csvMoney(d.expenses.total)],
            ...d.expenses.byAccount.map((e) => [`  ${e.account}`, "", csvMoney(e.total)]),
            [t("dayclose.csvTotalCashIn"), "", csvMoney(d.cashIn)],
            [t("dayclose.csvTotalCashOut"), "", csvMoney(d.cashOut)],
            [t("dayclose.csvNetCash"), "", csvMoney(d.netCash)],
          ] : []} />
        }
      />

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <label className="text-sm font-semibold">
          <span className="mb-1 block text-xs uppercase tracking-wider text-muted-foreground">{t("dayclose.date")}</span>
          <input type="date" className="field" value={date} max={fmtDateInput()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>
      </div>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-32 rounded-2xl" />)}</div>
      ) : !d ? (
        <EmptyState title={t("dayclose.errTitle")} hint={t("dayclose.errHint")} />
      ) : (
        <>
          {/* Net cash hero */}
          <div className={`card card-gloss rise rise-1 mb-4 overflow-hidden p-6 ${net >= 0n ? "" : ""}`}>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-xs font-extrabold uppercase tracking-widest text-muted-foreground">{t("dayclose.netCashDay")}</p>
                <p className={`mt-1 text-4xl font-black tracking-tight ${net >= 0n ? "text-primary" : "text-danger"}`}>
                  {net >= 0n ? "+" : "−"}{fmtMoney((net >= 0n ? net : -net).toString())}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("dayclose.cashFlow", { cashIn: fmtMoney(d.cashIn), cashOut: fmtMoney(d.cashOut) })}
                </p>
              </div>
              <span className="tile tile-primary h-16 w-16"><PiggyBank size={28} /></span>
            </div>
          </div>

          <div className="mb-4">
            <SummaryChips items={[
              { label: t("dayclose.chipSales", { count: d.sales.count }), value: fmtMoney(d.sales.total), tone: "primary" },
              { label: t("dayclose.chipNetSales"), value: fmtMoney(d.netSales), tone: "neutral" },
              { label: t("dayclose.chipCashReceived", { count: d.receipts.count }), value: fmtMoney(d.receipts.total), tone: "accent" },
              { label: t("dayclose.chipExpenses", { count: d.expenses.count }), value: fmtMoney(d.expenses.total), tone: "danger" },
            ]} />
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <DetailCard icon={<TrendingUp size={18} />} title={t("dayclose.cardSales")} count={d.sales.count} total={d.sales.total} href="/sales" linkText={t("dayclose.viewSales")} t={t} />
            <DetailCard icon={<Undo2 size={18} />} title={t("dayclose.cardSalesReturns")} count={d.salesReturns.count} total={d.salesReturns.total} href="/sales" linkText={t("dayclose.viewSales")} t={t} />
            <DetailCard icon={<ShoppingCart size={18} />} title={t("dayclose.cardPurchases")} count={d.purchases.count} total={d.purchases.total} href="/purchases" linkText={t("dayclose.viewPurchases")} t={t} />
            <DetailCard icon={<ArrowDownToLine size={18} />} title={t("dayclose.cardCashReceived")} count={d.receipts.count} total={d.receipts.total} href="/payments" linkText={t("dayclose.viewPayments")} t={t} />
            <DetailCard icon={<ArrowUpFromLine size={18} />} title={t("dayclose.cardCashPaid")} count={d.paymentsMade.count} total={d.paymentsMade.total} href="/payments" linkText={t("dayclose.viewPayments")} t={t} />
            <DetailCard icon={<Receipt size={18} />} title={t("dayclose.cardExpenses")} count={d.expenses.count} total={d.expenses.total} href="/expenses" linkText={t("dayclose.viewExpenses")} t={t} />
          </div>

          {d.expenses.byAccount.length > 0 && (
            <div className="card rise rise-2 mt-4 overflow-hidden">
              <h3 className="flex items-center gap-2 border-b border-border p-5 pb-4 text-sm font-extrabold uppercase tracking-wider text-muted-foreground">
                <Wallet size={15} /> {t("dayclose.expenseBreakdown")}
              </h3>
              <div className="overflow-x-auto">
                <table className="tbl">
                  <tbody>
                    {d.expenses.byAccount.map((e) => (
                      <tr key={e.account}>
                        <td className="font-semibold">{e.account}</td>
                        <td className="num font-bold">{fmtMoney(e.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t-2 border-border">
                      <td className="!py-3 font-extrabold">{t("common.total")}</td>
                      <td className="num !py-3 font-extrabold">{fmtMoney(d.expenses.total)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function DetailCard({ icon, title, count, total, href, linkText, t }: { icon: React.ReactNode; title: string; count: number; total: string; href: string; linkText: string; t: (key: string, vars?: Record<string, string | number>) => string }) {
  return (
    <div className="card card-gloss card-lift rise rise-2 p-5">
      <div className="flex items-center justify-between">
        <span className="tile tile-primary h-10 w-10">{icon}</span>
        <span className="text-xs font-bold text-muted-foreground">{count} {count === 1 ? t("dayclose.entryOne") : t("dayclose.entryMany")}</span>
      </div>
      <p className="mt-3 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="mt-1 text-2xl font-black tracking-tight">{fmtMoney(total)}</p>
      <a href={href} className="mt-2 inline-block text-sm font-bold text-primary hover:underline">{linkText} →</a>
    </div>
  );
}
