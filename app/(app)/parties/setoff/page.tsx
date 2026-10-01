"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeftRight, CheckCircle2 } from "lucide-react";
import { PageHeader, ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Party = { id: string; name: string; balance: string };
type OpenDoc = { id: string; docNo: string; date: number | string; dueDate: number | string | null; outstanding: string };
type WizardData = {
  customer: { id: string; name: string; receivable: string };
  supplier: { id: string; name: string; payable: string };
  openInvoices: OpenDoc[];
  openBills: OpenDoc[];
  maxSetoff: string;
};

function PartySelect({ kind, value, onChange, label }: { kind: "CUSTOMER" | "SUPPLIER"; value: string; onChange: (id: string) => void; label: string }) {
  const { t } = useLang();
  const [q, setQ] = useState("");
  const [options, setOptions] = useState<Party[]>([]);
  useEffect(() => {
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      api<{ data: Party[] }>(`/api/parties?kind=${kind}&q=${encodeURIComponent(q)}&perPage=15`)
        .then((d) => setOptions(d.data))
        .catch(() => {});
    }, 250);
    return () => { clearTimeout(timer); ctl.abort(); };
  }, [q, kind]);
  return (
    <Field label={label} required>
      <input
        className="input" value={options.find((o) => o.id === value)?.name ?? q}
        onChange={(e) => { setQ(e.target.value); onChange(""); }}
        placeholder={t("setoff.searchParty")}
      />
      {q && !value && options.length > 0 && (
        <ul className="card mt-1 max-h-48 overflow-auto p-1">
          {options.map((o) => (
            <li key={o.id}>
              <button
                type="button" className="flex w-full items-center justify-between rounded-lg px-3 py-2 text-start text-sm hover:bg-muted"
                onClick={() => { onChange(o.id); setQ(""); }}
              >
                <span className="font-semibold">{o.name}</span>
                <span className="text-xs text-muted-foreground">{fmtMoney(o.balance)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Field>
  );
}

function DocTable({ title, docs, empty }: { title: string; docs: OpenDoc[]; empty: string }) {
  const { t } = useLang();
  const total = docs.reduce((a, d) => a + BigInt(d.outstanding), 0n);
  return (
    <div className="card rise rise-1 overflow-hidden">
      <p className="border-b border-border px-4 py-3 text-sm font-extrabold">{title}</p>
      {docs.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{empty}</p> : (
        <div className="max-h-64 overflow-auto">
          <table className="tbl">
            <thead><tr><th>{t("setoff.colDoc")}</th><th>{t("setoff.colDate")}</th><th className="num">{t("setoff.colOutstanding")}</th></tr></thead>
            <tbody>
              {docs.map((d) => (
                <tr key={d.id}>
                  <td className="font-semibold">{d.docNo}</td>
                  <td className="text-muted-foreground">{fmtDate(d.date)}</td>
                  <td className="num">{fmtMoney(d.outstanding)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t border-border"><td colSpan={2} className="font-extrabold">{t("common.total")}</td><td className="num font-extrabold">{fmtMoney(total.toString())}</td></tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  );
}

export default function ContraWizardPage() {
  const { t } = useLang();
  const [customerId, setCustomerId] = useState("");
  const [supplierId, setSupplierId] = useState("");
  const [data, setData] = useState<WizardData | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [amount, setAmount] = useState("");
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState("");
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ entryId: string } | null>(null);

  const loadDocs = useCallback(() => {
    if (!customerId || !supplierId) { setData(null); return; }
    setLoadingDocs(true); setError(null);
    api<{ data: WizardData }>(`/api/parties/setoff/open-docs?customerId=${customerId}&supplierId=${supplierId}`)
      .then((d) => { setData(d.data); setAmount((BigInt(d.data.maxSetoff) / 100n).toString()); })
      .catch((e) => setError(e instanceof Error ? e.message : t("setoff.errLoad")))
      .finally(() => setLoadingDocs(false));
  }, [customerId, supplierId, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on pair change
  useEffect(() => { loadDocs(); }, [loadDocs]);

  const maxPaisa = data ? BigInt(data.maxSetoff) : 0n;
  const amountPaisa = (() => {
    const s = amount.trim();
    if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return 0n;
    const [w, f = ""] = s.split(".");
    return BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
  })();
  const canPost = !!data && amountPaisa > 0n && amountPaisa <= maxPaisa && !posting;

  async function post() {
    if (!canPost || !data) return;
    setPosting(true); setError(null);
    try {
      const d = await api<{ data: { entryId: string } }>("/api/parties/setoff", {
        method: "POST",
        headers: { "X-Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ customerId: data.customer.id, supplierId: data.supplier.id, amount: amount.trim(), date, notes: notes.trim() || undefined }),
      });
      setDone({ entryId: d.data.entryId });
    } catch (e) {
      setError(e instanceof Error ? e.message : t("setoff.errPost"));
      setPosting(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("setoff.title")}
        subtitle={t("setoff.subtitle")}
        icon={<ArrowLeftRight size={20} />}
      />
      {error && <ErrorNote message={error} />}

      {done ? (
        <div className="card rise rise-1 mx-auto max-w-lg p-8 text-center">
          <CheckCircle2 size={40} className="mx-auto text-success" />
          <h3 className="mt-3 text-lg font-extrabold">{t("setoff.doneTitle")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">{t("setoff.doneText", { amount: fmtMoney(amount) })}</p>
          <div className="mt-5 flex justify-center gap-2">
            <Link href={`/reports/journal?q=${encodeURIComponent(data?.customer.name ?? "")}`} className="btn btn-primary">{t("setoff.viewJournal")}</Link>
            <button className="btn btn-ghost" onClick={() => { setDone(null); setCustomerId(""); setSupplierId(""); setData(null); }}>{t("setoff.another")}</button>
          </div>
        </div>
      ) : (
        <>
          <div className="card rise rise-1 mb-4 p-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <PartySelect kind="CUSTOMER" value={customerId} onChange={setCustomerId} label={t("setoff.customer")} />
              <PartySelect kind="SUPPLIER" value={supplierId} onChange={setSupplierId} label={t("setoff.supplier")} />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">{t("setoff.pairHint")}</p>
          </div>

          {loadingDocs && <div className="space-y-3"><div className="skeleton h-24 rounded-2xl" /></div>}

          {data && (
            <>
              <div className="mb-4 grid gap-4 lg:grid-cols-2">
                <DocTable title={t("setoff.openInvoices", { name: data.customer.name })} docs={data.openInvoices} empty={t("setoff.noOpenInvoices")} />
                <DocTable title={t("setoff.openBills", { name: data.supplier.name })} docs={data.openBills} empty={t("setoff.noOpenBills")} />
              </div>

              <div className="card rise rise-2 p-4">
                <div className="grid gap-3 sm:grid-cols-3">
                  <Field label={t("setoff.amount")} required hint={t("setoff.maxHint", { max: fmtMoney(maxPaisa.toString()) })}>
                    <input className="input num" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
                  </Field>
                  <Field label={t("setoff.date")} required>
                    <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
                  </Field>
                  <Field label={t("common.notes")}>
                    <input className="input" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={200} placeholder={t("setoff.notesPh")} />
                  </Field>
                </div>
                <div className="mt-3 rounded-xl bg-muted/60 p-3 text-sm">
                  <p className="font-semibold">{t("setoff.postingPreview")}</p>
                  <p className="mt-1 font-mono text-xs text-muted-foreground" dir="ltr">
                    Dr 2001 {t("setoff.apName")} · {fmtMoney(amountPaisa.toString())}<br />
                    Cr 1100 {t("setoff.arName")} · {fmtMoney(amountPaisa.toString())}
                  </p>
                </div>
                {amountPaisa > maxPaisa && (
                  <p className="mt-2 text-xs font-semibold text-danger">{t("setoff.errTooMuch", { max: fmtMoney(maxPaisa.toString()) })}</p>
                )}
                <div className="mt-4 flex justify-end">
                  <button className="btn btn-primary" onClick={post} disabled={!canPost}>
                    {posting ? t("setoff.posting") : t("setoff.postSetoff")}
                  </button>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
