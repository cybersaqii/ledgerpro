"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, ChevronDown, Plus } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Row = {
  id: string;
  date: number | string;
  partyName: string | null;
  type: string;
  refNo: string;
  total: string;
  balance: string;
  href: string;
};

const PER_PAGE = 50;


function AddNewPurchases({ t }: { t: (k: string) => string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const options = [
    { label: t("docs.addOptBill"), href: "/purchases/new" },
    { label: t("docs.addOptCreditNoteP"), href: "/purchases/notes/new" },
  ];
  useEffect(() => {
    if (!open) return;
    const fn = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("mousedown", fn);
    return () => document.removeEventListener("mousedown", fn);
  }, [open]);
  return (
    <div className="relative" ref={ref}>
      <div className="flex">
        <Link href="/purchases/new" className="btn btn-primary !rounded-e-none text-sm">
          <Plus size={16} /> {t("common.addNew")}
        </Link>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="menu"
          className="btn btn-primary !rounded-s-none !px-2 text-sm border-s border-white/25">
          <ChevronDown size={16} />
        </button>
      </div>
      {open && (
        <div className="absolute end-0 z-20 mt-1 w-48 rounded-xl border border-border bg-card py-1 shadow-xl" role="menu">
          {options.map((o) => (
            <Link key={o.href + o.label} href={o.href} className="block px-4 py-2 text-sm hover:bg-muted" role="menuitem" onClick={() => setOpen(false)}>
              {o.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function PurchasesAllPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [bills, payments] = await Promise.all([
        api<{ data: { id: string; docNo: string; docType: string; date: number; grandTotal: string; partyName: string | null; amountPaid: string }[] }>(
          `/api/purchases?perPage=${PER_PAGE}`
        ),
        api<{ data: { id: string; date: number; amount: string; partyName: string | null; reference: string | null }[] }>(
          `/api/payments?kind=PAYMENT&perPage=${PER_PAGE}`
        ),
      ]);
      const merged: Row[] = [
        ...(bills.data ?? []).map((d) => ({
          id: `B-${d.id}`,
          date: d.date,
          partyName: d.partyName,
          type: d.docType === "BILL" ? t("nav.bills") : d.docType,
          refNo: d.docNo,
          total: d.grandTotal,
          balance: String(toBig(d.grandTotal) - toBig(d.amountPaid)),
          href: `/purchases/${d.id}`,
        })),
        ...(payments.data ?? []).map((p) => ({
          id: `P-${p.id}`,
          date: p.date,
          partyName: p.partyName,
          type: t("nav.payments"),
          refNo: p.reference ?? "—",
          total: p.amount,
          balance: "0",
          href: `/payments/${p.id}`,
        })),
      ];
      merged.sort((a, b) => Number(b.date) - Number(a.date));
      setRows(merged);
    } catch {
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title={t("nav.purchasesAll")}
        icon={<ArrowLeftRight size={20} />}
        actions={
          <AddNewPurchases t={t} />
        }
      />
      {loading ? (
        <div className="card p-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <EmptyState title={t("common.noResults")} />
      ) : (
        <div className="card overflow-x-auto">
          <table className="tbl tbl-fa">
            <thead>
              <tr>
                <th>{t("docs.colDate")}</th>
                <th>{t("nav.suppliers")}</th>
                <th>{t("docs.colType")}</th>
                <th>{t("docs.colBillNo")}</th>
                <th className="text-end">{t("docs.colTotal")}</th>
                <th className="text-end">{t("docs.colBalance")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td>{r.partyName ?? "—"}</td>
                  <td><span className="badge bg-muted text-muted-foreground">{r.type}</span></td>
                  <td>
                    <Link href={r.href} className="font-bold text-primary hover:underline">
                      {r.refNo}
                    </Link>
                  </td>
                  <td className="text-end font-semibold">{fmtMoney(r.total)}</td>
                  <td className="text-end">{fmtMoney(r.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
