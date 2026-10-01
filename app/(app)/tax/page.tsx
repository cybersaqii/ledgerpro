"use client";

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import {
  Landmark, Radio, FileBadge, FileSpreadsheet, Copy, Check, Printer,
  Download, TriangleAlert, QrCode,
} from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, FilterBar, Pagination, Stat } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtDate, fmtDateInput } from "@/lib/format";
import { WHT_SECTIONS } from "@/lib/wht";

type Tab = "fbr" | "wht" | "annex";

// ─── FBR tab types ─────────────────────────────────────────────

type FbrConfig = {
  posId: string; environment: "SANDBOX" | "PRODUCTION"; storeCode: string;
  cashierId: string; qrPlacement: "TOP" | "BOTTOM"; isEnabled: boolean;
  tokenSet: boolean; tokenLast4: string | null;
  sync: { connected: false; status: string; message: string };
};

type QueueRow = {
  id: string; docType: string; docId: string; invoiceNumber: string;
  status: string; attempts: number; error: string | null; createdAt: string;
  payload: { InvoiceNumber?: string; InvoiceType?: string; TotalSaleValue?: string; TotalTaxCharged?: string; POSID?: string | null } | null;
  qrData: string; totalRs: string;
};

/** Small QR image rendered client-side from a data string (dynamic import,
 *  same pattern as the invoice print view). */
function QrImage({ data }: { data: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- QR render on data change */
    let live = true;
    setUrl(null);
    import("qrcode")
      .then(({ default: QRCode }) => QRCode.toDataURL(data, { width: 120, margin: 1 }))
      .then((u) => { if (live) setUrl(u); })
      .catch(() => {});
    return () => { live = false; };
  }, [data]);
  if (!url) return <span className="inline-block h-16 w-16 animate-pulse rounded bg-muted" aria-hidden />;
  return <img src={url} alt="QR" className="h-16 w-16 rounded border border-border bg-white" />;
}

function FbrTab() {
  const { t } = useLang();
  const canSettings = useCan("settings");
  const [cfg, setCfg] = useState<FbrConfig | null>(null);
  const [form, setForm] = useState({ posId: "", environment: "SANDBOX", storeCode: "", cashierId: "", qrPlacement: "BOTTOM", tokenSecret: "" });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [queue, setQueue] = useState<QueueRow[]>([]);
  const [qTotal, setQTotal] = useState(0);
  const [qPage, setQPage] = useState(1);
  const [copied, setCopied] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const c = await api<{ data: FbrConfig }>("/api/tax/fbr-config");
      setCfg(c.data);
      setForm({
        posId: c.data.posId, environment: c.data.environment, storeCode: c.data.storeCode,
        cashierId: c.data.cashierId, qrPlacement: c.data.qrPlacement, tokenSecret: "",
      });
    } catch { setError(t("tax.loadError")); }
    finally { setLoading(false); }
  }, [t]);

  const loadQueue = useCallback(async (page: number) => {
    try {
      const q = await api<{ data: QueueRow[]; total: number }>(`/api/tax/fbr-queue?page=${page}&perPage=10`);
      setQueue(q.data);
      setQTotal(q.total);
      setQPage(page);
    } catch { /* queue is informational; the config error already surfaces */ }
  }, []);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load(); loadQueue(1);
  }, [load, loadQueue]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null); setSaved(false); setSaving(true);
    try {
      const c = await api<{ data: FbrConfig }>("/api/tax/fbr-config", {
        method: "PUT",
        body: JSON.stringify({ ...form, tokenSecret: form.tokenSecret || undefined }),
      });
      setCfg(c.data);
      setForm((f) => ({ ...f, tokenSecret: "" }));
      setSaved(true);
    } catch (err) { setError(err instanceof Error ? err.message : t("tax.loadError")); }
    finally { setSaving(false); }
  }

  async function copyQr(id: string, data: string) {
    try {
      await navigator.clipboard.writeText(data);
      setCopied(id);
      setTimeout(() => setCopied(null), 1500);
    } catch { /* clipboard unavailable */ }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    { setForm((f) => ({ ...f, [k]: e.target.value })); setSaved(false); };

  return (
    <div className="space-y-5">
      {/* Honest status banner — live sync does not exist. */}
      <div className="card flex items-start gap-3 border-amber-500/40 bg-amber-500/10 p-4 sm:p-5">
        <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-sm font-extrabold text-amber-800 dark:text-amber-200">
            {t("tax.fbrStatus")}: {t("tax.fbrNotConnected")}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-amber-700 dark:text-amber-300/90">
            {t("tax.fbrNotConnectedHint")}
          </p>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-2">
        {/* Config form */}
        <div className="card p-5 sm:p-6">
          <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold">
            <Radio className="h-5 w-5 text-primary" /> {t("tax.fbrTitle")}
          </h2>
          <p className="mb-5 text-xs text-muted-foreground">
            {cfg?.tokenSet ? `${t("tax.tokenSet")} (••••${cfg.tokenLast4})` : t("tax.tokenNotSet")}
          </p>
          {loading ? <p className="text-sm text-muted-foreground">…</p> : (
            <form onSubmit={save} className="space-y-4">
              <ErrorNote message={error} />
              <Field label={t("tax.posId")} required>
                <input className="input" value={form.posId} onChange={set("posId")} placeholder={t("tax.posIdPh")} disabled={!canSettings} />
              </Field>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t("tax.environment")}>
                  <select className="input" value={form.environment} onChange={set("environment")} disabled={!canSettings}>
                    <option value="SANDBOX">{t("tax.envSandbox")}</option>
                    <option value="PRODUCTION">{t("tax.envProduction")}</option>
                  </select>
                </Field>
                <Field label={t("tax.qrPlacement")}>
                  <select className="input" value={form.qrPlacement} onChange={set("qrPlacement")} disabled={!canSettings}>
                    <option value="BOTTOM">{t("tax.qrBottom")}</option>
                    <option value="TOP">{t("tax.qrTop")}</option>
                  </select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t("tax.storeCode")}>
                  <input className="input" value={form.storeCode} onChange={set("storeCode")} disabled={!canSettings} />
                </Field>
                <Field label={t("tax.cashierId")}>
                  <input className="input" value={form.cashierId} onChange={set("cashierId")} disabled={!canSettings} />
                </Field>
              </div>
              <Field label={t("tax.tokenSecret")} hint={t("tax.tokenSecretHint")}>
                <input type="password" className="input" value={form.tokenSecret} onChange={set("tokenSecret")}
                  placeholder={cfg?.tokenSet ? "••••" : ""} disabled={!canSettings} autoComplete="off" />
              </Field>
              {canSettings && (
                <button type="submit" disabled={saving} className="btn-primary w-full py-3 text-sm font-bold disabled:opacity-60">
                  {saving ? t("tax.saving") : t("tax.saveConfig")}
                </button>
              )}
              {saved && <p className="text-center text-xs font-bold text-emerald-600">{t("tax.saved")}</p>}
            </form>
          )}
        </div>

        {/* Sync queue */}
        <div className="card p-5 sm:p-6">
          <h2 className="mb-1 flex items-center gap-2 text-base font-extrabold">
            <QrCode className="h-5 w-5 text-primary" /> {t("tax.queueTitle")}
          </h2>
          <p className="mb-4 text-xs text-muted-foreground">{t("tax.queueSub")}</p>
          {queue.length === 0 ? (
            <EmptyState title={t("tax.queueEmpty")} icon={<QrCode className="h-8 w-8" />} />
          ) : (
            <ul className="space-y-3">
              {queue.map((q) => (
                <li key={q.id} className="rounded-xl border border-border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-extrabold">{q.invoiceNumber}</p>
                      <p className="text-xs text-muted-foreground">
                        {q.payload?.InvoiceType === "Return" ? "Return" : "New"} · {fmtDate(q.createdAt)} · Rs {q.totalRs}
                      </p>
                      <span className="mt-1.5 inline-block rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold text-muted-foreground">
                        {t("tax.statusDisabled")}
                      </span>
                    </div>
                    <QrImage data={q.qrData} />
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-[11px] text-muted-foreground" dir="ltr">
                      {q.qrData}
                    </code>
                    <button type="button" onClick={() => copyQr(q.id, q.qrData)}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition hover:text-foreground"
                      title={t("tax.copyQr")} aria-label={t("tax.copyQr")}>
                      {copied === q.id ? <Check className="h-4 w-4 text-emerald-600" /> : <Copy className="h-4 w-4" />}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {qTotal > 10 && (
            <div className="mt-4">
              <Pagination page={qPage} perPage={10} total={qTotal} onPage={(p) => loadQueue(p)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── WHT tab types ─────────────────────────────────────────────

type WhtRow = {
  id: string; date: string; kind: string; docId: string | null; paymentId: string | null;
  partyId: string; deducteeName: string; ntnCnic: string | null; taxSection: string;
  rateBps: number; gross: string; wht: string; grossFmt: string; whtFmt: string;
  cprNo: string | null; depositedAt: string | null;
};

function WhtTab() {
  const { t } = useLang();
  const [rows, setRows] = useState<WhtRow[]>([]);
  const [total, setTotal] = useState(0);
  const [totalWhtFmt, setTotalWhtFmt] = useState("");
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState(() => fmtDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [to, setTo] = useState(() => fmtDateInput(new Date()));
  const [section, setSection] = useState("");
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<string | null>(null);
  const [cpr, setCpr] = useState("");
  const [dep, setDep] = useState(false);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const q = new URLSearchParams({ page: String(p), perPage: "15", from, to });
      if (section) q.set("section", section);
      if (kind) q.set("kind", kind);
      const r = await api<{ data: WhtRow[]; total: number; totalWhtFmt: string }>(`/api/tax/wht-deductions?${q}`);
      setRows(r.data); setTotal(r.total); setTotalWhtFmt(r.totalWhtFmt); setPage(p);
    } catch { /* empty state covers */ }
    finally { setLoading(false); }
  }, [from, to, section, kind]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- register reload on filter change */
    load(1);
  }, [load]);

  function startEdit(row: WhtRow) {
    setEditing(row.id);
    setCpr(row.cprNo ?? "");
    setDep(!!row.depositedAt);
  }

  async function saveCpr(id: string) {
    try {
      await api(`/api/tax/wht-deductions/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ cprNo: cpr, deposited: dep }),
      });
      setEditing(null);
      load(page);
    } catch { /* keep editor open on failure */ }
  }

  const kindLabel = (k: string) =>
    k === "BILL" ? t("tax.kindBill") : k === "PAYMENT" ? t("tax.kindPayment") : t("tax.kindReceipt");

  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label={t("tax.whtTitle")} value={totalWhtFmt || "—"} sub={t("tax.whtTotal")} icon={<FileBadge className="h-5 w-5" />} />
      </div>

      <FilterBar>
        <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("tax.from")} />
        <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("tax.to")} />
        <select className="input w-auto" value={section} onChange={(e) => setSection(e.target.value)} aria-label={t("tax.filterSection")}>
          <option value="">{t("tax.filterSection")}: {t("tax.all")}</option>
          {WHT_SECTIONS.map((s) => <option key={s.code} value={s.code}>{s.code}</option>)}
        </select>
        <select className="input w-auto" value={kind} onChange={(e) => setKind(e.target.value)} aria-label={t("tax.filterKind")}>
          <option value="">{t("tax.filterKind")}: {t("tax.all")}</option>
          <option value="BILL">{t("tax.kindBill")}</option>
          <option value="PAYMENT">{t("tax.kindPayment")}</option>
          <option value="RECEIPT">{t("tax.kindReceipt")}</option>
        </select>
      </FilterBar>

      <div className="card overflow-hidden">
        {loading ? <p className="p-6 text-sm text-muted-foreground">…</p> : rows.length === 0 ? (
          <div className="p-6"><EmptyState title={t("tax.whtEmpty")} icon={<FileBadge className="h-8 w-8" />} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs text-muted-foreground">
                  <th className="px-4 py-3 text-start font-bold">{t("tax.whtDate")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.whtDeductee")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.whtSection")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.whtKind")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.whtGross")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.whtTax")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.whtCpr")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.whtCertificate")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3">{fmtDate(r.date)}</td>
                    <td className="px-4 py-3">
                      <p className="font-bold">{r.deducteeName}</p>
                      {r.ntnCnic && <p className="text-xs text-muted-foreground" dir="ltr">{r.ntnCnic}</p>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold">{r.taxSection}</span>
                      <p className="mt-0.5 text-xs text-muted-foreground">{(r.rateBps / 100).toString()}%</p>
                    </td>
                    <td className="px-4 py-3 text-xs font-semibold text-muted-foreground">{kindLabel(r.kind)}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">{r.grossFmt}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end font-extrabold">{r.whtFmt}</td>
                    <td className="px-4 py-3">
                      {editing === r.id ? (
                        <div className="flex min-w-[200px] items-center gap-2">
                          <input className="input !py-1.5 text-xs" value={cpr} onChange={(e) => setCpr(e.target.value)}
                            placeholder={t("tax.cprPh")} dir="ltr" />
                          <label className="flex shrink-0 items-center gap-1 text-xs font-semibold">
                            <input type="checkbox" checked={dep} onChange={(e) => setDep(e.target.checked)} />
                            {t("tax.deposited")}
                          </label>
                          <button type="button" onClick={() => saveCpr(r.id)} className="btn-primary shrink-0 !px-3 !py-1.5 text-xs">
                            <Check className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => startEdit(r)}
                          className="text-xs font-bold text-primary hover:underline" title={t("tax.whtSetCpr")}>
                          {r.cprNo ? (
                            <span dir="ltr">{r.cprNo}{r.depositedAt ? ` · ${t("tax.deposited")}` : ""}</span>
                          ) : (
                            <span className="text-muted-foreground">+ {t("tax.whtSetCpr")}</span>
                          )}
                        </button>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">
                      <Link href={`/tax/wht/${r.id}`}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-bold transition hover:border-primary hover:text-primary">
                        <Printer className="h-3.5 w-3.5" /> {t("tax.whtCertificate")}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > 15 && (
          <div className="border-t border-border p-4">
            <Pagination page={page} perPage={15} total={total} onPage={(p) => load(p)} />
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Annexures tab ─────────────────────────────────────────────

type AnnexRow = {
  docNo: string; docType: string; date: string; rateBps: number;
  name: string; ntn: string | null; value: string; tax: string;
  valueFmt: string; taxFmt: string; vendorRef?: string | null;
};

function AnnexTab() {
  const { t } = useLang();
  const [which, setWhich] = useState<"c" | "a">("c");
  const [from, setFrom] = useState(() => fmtDateInput(new Date(new Date().getFullYear(), new Date().getMonth(), 1)));
  const [to, setTo] = useState(() => fmtDateInput(new Date()));
  const [rows, setRows] = useState<AnnexRow[]>([]);
  const [totalValueFmt, setTotalValueFmt] = useState("");
  const [totalTaxFmt, setTotalTaxFmt] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api<{
        data: (AnnexRow & { buyerNtn?: string | null; buyerName?: string; salesValue?: string; supplierNtn?: string | null; supplierName?: string; purchaseValue?: string })[];
        totalValueFmt: string; totalTaxFmt: string;
      }>(`/api/tax/annexure-${which}?from=${from}&to=${to}`);
      setRows(r.data.map((x) => ({
        docNo: x.docNo, docType: x.docType, date: x.date, rateBps: x.rateBps,
        name: x.buyerName ?? x.supplierName ?? "", ntn: x.buyerNtn ?? x.supplierNtn ?? null,
        value: x.salesValue ?? x.purchaseValue ?? "0", tax: x.tax,
        valueFmt: (x as { salesValueFmt?: string; purchaseValueFmt?: string }).salesValueFmt
          ?? (x as { purchaseValueFmt?: string }).purchaseValueFmt ?? "",
        taxFmt: x.taxFmt, vendorRef: (x as { vendorRef?: string | null }).vendorRef,
      })));
      setTotalValueFmt(r.totalValueFmt);
      setTotalTaxFmt(r.totalTaxFmt);
    } catch { setRows([]); }
    finally { setLoading(false); }
  }, [which, from, to]);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- annexure reload on period change */
    load();
  }, [load]);

  const csvHref = `/api/tax/annexure-${which}?format=csv&from=${from}&to=${to}`;

  return (
    <div className="space-y-5">
      <div className="mb-2 flex rounded-xl border border-border bg-muted/60 p-1 sm:max-w-md">
        {([["c", t("tax.annexC")], ["a", t("tax.annexA")]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setWhich(k)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-bold transition ${which === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>

      <FilterBar>
        <input type="date" className="input w-auto" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("tax.from")} />
        <input type="date" className="input w-auto" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("tax.to")} />
        <a href={csvHref} className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-xs font-bold" download>
          <Download className="h-4 w-4" /> {t("tax.exportCsv")}
        </a>
      </FilterBar>

      <div className="grid gap-3 sm:grid-cols-2">
        <Stat label={t("tax.totalValue")} value={totalValueFmt || "—"} icon={<FileSpreadsheet className="h-5 w-5" />} />
        <Stat label={t("tax.totalTax")} value={totalTaxFmt || "—"} icon={<Landmark className="h-5 w-5" />} />
      </div>

      <div className="card overflow-hidden">
        {loading ? <p className="p-6 text-sm text-muted-foreground">…</p> : rows.length === 0 ? (
          <div className="p-6"><EmptyState title={t("tax.annexEmpty")} icon={<FileSpreadsheet className="h-8 w-8" />} /></div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-border text-xs text-muted-foreground">
                  <th className="px-4 py-3 text-start font-bold">{t("tax.colDate")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.colName")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.colNtn")}</th>
                  <th className="px-4 py-3 text-start font-bold">{t("tax.colDocNo")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.colRate")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.colValue")}</th>
                  <th className="px-4 py-3 text-end font-bold">{t("tax.colTax")}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className="border-b border-border/60 last:border-0">
                    <td className="whitespace-nowrap px-4 py-3">{fmtDate(r.date)}</td>
                    <td className="px-4 py-3 font-semibold">{r.name}</td>
                    <td className="px-4 py-3 text-xs" dir="ltr">{r.ntn || "—"}</td>
                    <td className="whitespace-nowrap px-4 py-3">
                      {r.docNo}
                      {r.vendorRef && <p className="text-xs text-muted-foreground" dir="ltr">{r.vendorRef}</p>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">{(r.rateBps / 100).toString()}%</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end">{r.valueFmt}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-end font-extrabold">{r.taxFmt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ──────────────────────────────────────────────────────

export default function TaxPage() {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>("fbr");

  return (
    <div>
      <PageHeader title={t("tax.title")} subtitle={t("tax.subtitle")}
        icon={<Landmark className="h-6 w-6 text-primary" />} />
      <div className="mb-6 flex rounded-xl border border-border bg-muted/60 p-1 sm:max-w-lg">
        {([["fbr", t("tax.tabFbr")], ["wht", t("tax.tabWht")], ["annex", t("tax.tabAnnex")]] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setTab(k)}
            className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-bold transition ${tab === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>
      {tab === "fbr" && <FbrTab />}
      {tab === "wht" && <WhtTab />}
      {tab === "annex" && <AnnexTab />}
    </div>
  );
}
