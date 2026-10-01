"use client";

import { useCallback, useEffect, useState } from "react";
import { FileText, ClipboardList, Wallet, ScrollText, Plus, Trash2, Printer, ShieldAlert, Globe } from "lucide-react";
import { EmptyState, ErrorNote, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate } from "@/lib/format";

type Ctx = {
  companyName: string; companyPhone: string | null; companyEmail: string | null;
  partyName: string; partyKind: string; accessLevel: string; expiresAt: number | null;
};

type Doc = {
  id: string; docNo: string; docType: string; date: string;
  netTotalPaisa: string; amountPaidPaisa: string; status: string; dueDate: string | null;
};

type ReqRow = {
  id: string; requestNo: string; kind: string; status: string;
  grandTotalPaisa: string; vendorRef: string | null; rejectionReason: string | null;
  createdAt: number;
};

type IntentRow = {
  id: string; docId: string; amountPaisa: string; method: string;
  reference: string | null; status: string; createdAt: number;
};

type Product = { id: string; name: string; sku: string | null; unit: string; salePrice: string };

type Line = { productId: string; qty: string };

const METHODS = ["CASH", "BANK", "JAZZCASH", "EASYPAISA", "CARD", "OTHER"];

const rank = (a: string) => (a === "VIEW_ONLY" ? 0 : a === "ORDER" ? 1 : 2);

export function PortalClient({ token, ctx }: { token: string; ctx: Ctx }) {
  const { t, lang, setLang } = useLang();
  const [tab, setTab] = useState<"docs" | "requests" | "payments" | "statement">("docs");
  const [docs, setDocs] = useState<Doc[]>([]);
  const [requests, setRequests] = useState<ReqRow[]>([]);
  const [intents, setIntents] = useState<IntentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Order/request form
  const [products, setProducts] = useState<Product[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [lines, setLines] = useState<Line[]>([{ productId: "", qty: "1" }]);
  const [notes, setNotes] = useState("");
  const [vendorRef, setVendorRef] = useState("");
  const [freeLines, setFreeLines] = useState<{ description: string; qty: string; rate: string }[]>([{ description: "", qty: "1", rate: "" }]);
  const [formBusy, setFormBusy] = useState(false);
  // Payment intent form
  const [intentDoc, setIntentDoc] = useState<Doc | null>(null);
  const [intentAmount, setIntentAmount] = useState("");
  const [intentMethod, setIntentMethod] = useState("BANK");
  const [intentRef, setIntentRef] = useState("");
  const [intentBusy, setIntentBusy] = useState(false);
  // Statement
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [stmt, setStmt] = useState<{ openingPaisa: string; closingPaisa: string; lines: { date: string; docNo: string | null; description: string; debitPaisa: string; creditPaisa: string }[] } | null>(null);
  const [stmtBusy, setStmtBusy] = useState(false);

  const canOrder = rank(ctx.accessLevel) >= 1;
  const canCancel = rank(ctx.accessLevel) >= 2;
  const isSupplier = ctx.partyKind === "SUPPLIER";

  const base = `/api/portal/${token}`;

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const d = await api<{ docs: Doc[]; requests: ReqRow[]; intents: IntentRow[] }>(base);
      setDocs(d.docs);
      setRequests(d.requests);
      setIntents(d.intents);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- portal data fetch on mount
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (showForm && products.length === 0 && !isSupplier) {
      api<{ data: Product[] }>(`${base}/products`).then((d) => setProducts(d.data)).catch(() => {});
    }
  }, [showForm, products.length, isSupplier, base]);

  const outstanding = (d: Doc) => BigInt(d.netTotalPaisa) - BigInt(d.amountPaidPaisa);
  const totalOutstanding = docs.reduce((s, d) => s + outstanding(d), 0n);

  function flash(msg: string) {
    setNotice(msg);
    window.setTimeout(() => setNotice(null), 5000);
  }

  async function submitRequest(draft: boolean) {
    const items = isSupplier
      ? freeLines.filter((l) => l.description.trim()).map((l) => ({
          description: l.description.trim(),
          qty: Math.max(1, Math.round(parseFloat(l.qty || "1") * 1000)),
          ratePaisa: Math.round(parseFloat(l.rate || "0") * 100),
        }))
      : lines.filter((l) => l.productId).map((l) => {
          const p = products.find((x) => x.id === l.productId)!;
          return {
            productId: p.id, description: p.name,
            qty: Math.max(1, Math.round(parseFloat(l.qty || "1") * 1000)),
            ratePaisa: parseInt(p.salePrice, 10),
          };
        });
    if (items.length === 0) { setError(t("portal.emptyItems")); return; }
    setFormBusy(true); setError(null);
    try {
      const d = await api<{ data: { id: string } }>(`${base}/order-requests`, {
        method: "POST",
        body: JSON.stringify({
          kind: isSupplier ? "BILL_SUBMISSION" : "SALES_ORDER",
          notes: notes.trim() || undefined,
          vendorRef: isSupplier ? vendorRef.trim() || undefined : undefined,
          items,
        }),
      });
      if (!draft) {
        await api(`${base}/order-requests/${d.data.id}/submit`, { method: "POST" });
        flash(t("portal.requestSubmitted"));
      } else {
        flash(t("portal.requestCreated"));
      }
      setShowForm(false); setLines([{ productId: "", qty: "1" }]);
      setFreeLines([{ description: "", qty: "1", rate: "" }]);
      setNotes(""); setVendorRef("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setFormBusy(false);
    }
  }

  async function cancelRequest(id: string) {
    if (!window.confirm(t("portal.cancelRequestConfirm"))) return;
    try {
      await api(`${base}/order-requests/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("common.saveError")); }
  }

  async function submitRequestSubmit(id: string) {
    try {
      await api(`${base}/order-requests/${id}/submit`, { method: "POST" });
      flash(t("portal.requestSubmitted"));
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("common.saveError")); }
  }

  function openIntentModal(d: Doc) {
    setIntentDoc(d);
    setIntentAmount((outstanding(d) / 100n).toString());
    setIntentMethod("BANK"); setIntentRef("");
  }

  async function submitIntent() {
    if (!intentDoc) return;
    setIntentBusy(true); setError(null);
    try {
      await api(`${base}/payment-intents`, {
        method: "POST",
        body: JSON.stringify({
          docId: intentDoc.id,
          amountPaisa: Math.round(parseFloat(intentAmount || "0") * 100),
          method: intentMethod,
          reference: intentRef.trim() || undefined,
        }),
      });
      setIntentDoc(null);
      flash(t("portal.intentRecorded"));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.saveError"));
    } finally {
      setIntentBusy(false);
    }
  }

  async function cancelIntent(id: string) {
    try {
      await api(`${base}/payment-intents/${id}/cancel`, { method: "POST" });
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : t("common.saveError")); }
  }

  async function loadStatement() {
    if (!from || !to) return;
    setStmtBusy(true); setError(null);
    try {
      const d = await api<{ openingPaisa: string; closingPaisa: string; lines: { date: string; docNo: string | null; description: string; debitPaisa: string; creditPaisa: string }[] }>(
        `${base}/statement?from=${from}&to=${to}`
      );
      setStmt(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    } finally {
      setStmtBusy(false);
    }
  }

  async function revokeOwn() {
    if (!window.confirm(t("portal.revokeOwnConfirm"))) return;
    try {
      await api(base, { method: "POST", body: JSON.stringify({ action: "revoke" }) });
      window.location.reload();
    } catch (e) { setError(e instanceof Error ? e.message : t("common.saveError")); }
  }

  const tabs = [
    ["docs", isSupplier ? t("portal.bills") : t("portal.invoices"), <FileText key="i" size={16} />],
    ["requests", t("portal.myRequests"), <ClipboardList key="i" size={16} />],
    ["payments", t("portal.payments"), <Wallet key="i" size={16} />],
    ["statement", t("portal.statements"), <ScrollText key="i" size={16} />],
  ] as const;

  return (
    <div className="min-h-dvh bg-zinc-100 dark:bg-zinc-950">
      <style>{`@media print { .no-print { display: none !important; } body { background: white; } }`}</style>

      {/* Branded header */}
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-4 py-4">
          <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-emerald-600 text-xl font-black text-white">
            {ctx.companyName.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-lg font-black text-zinc-900 dark:text-zinc-100">{ctx.companyName}</h1>
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              {t("portal.welcome")}, <b className="text-zinc-700 dark:text-zinc-200">{ctx.partyName}</b>
            </p>
          </div>
          <button className="btn btn-ghost !p-2 no-print" onClick={() => setLang(lang === "en" ? "ur" : "en")} title={t("portal.language")} aria-label={t("portal.language")}>
            <Globe size={16} /> <span className="text-xs font-bold">{lang === "en" ? "اردو" : "EN"}</span>
          </button>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 pb-16">
        <ErrorNote message={error} />
        {notice && <div className="mt-3 rounded-xl border border-emerald-300 bg-emerald-50 p-3 text-sm font-bold text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">{notice}</div>}

        {!canOrder && (
          <p className="mt-3 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{t("portal.viewOnlyNote")}</p>
        )}

        {/* Outstanding summary */}
        <div className="mt-4 grid grid-cols-2 gap-3">
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("portal.outstanding")}</div>
            <div className="num mt-1 text-2xl font-black text-emerald-700 dark:text-emerald-400">{fmtMoney(totalOutstanding.toString())}</div>
          </div>
          <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <div className="text-xs font-bold uppercase tracking-wide text-zinc-500">{t("portal.accessLabel")}</div>
            <div className="mt-1 text-sm font-extrabold text-zinc-800 dark:text-zinc-200">
              {t(`portal.${ctx.accessLevel === "ORDER" ? "orderAccess" : ctx.accessLevel === "FULL" ? "fullAccess" : "viewOnly"}`)}
            </div>
            {ctx.expiresAt && <div className="text-xs text-zinc-500">{t("portal.expires")}: {fmtDate(new Date(ctx.expiresAt).toISOString())}</div>}
          </div>
        </div>

        {/* Tabs */}
        <div className="no-print mt-4 flex gap-1 overflow-x-auto rounded-xl border border-zinc-200 bg-white p-1 dark:border-zinc-800 dark:bg-zinc-900">
          {tabs.map(([k, label, icon]) => (
            <button key={k} onClick={() => setTab(k)}
              className={`flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-sm font-bold transition ${tab === k ? "bg-emerald-600 text-white shadow" : "text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"}`}>
              {icon}{label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="mt-4 space-y-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-20 rounded-2xl" />)}</div>
        ) : (
          <>
            {tab === "docs" && (
              <div className="mt-4 space-y-3">
                {docs.length === 0 ? (
                  <div className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
                    <EmptyState title={isSupplier ? t("portal.noBills") : t("portal.noDocs")} />
                  </div>
                ) : docs.map((d) => {
                  const out = outstanding(d);
                  return (
                    <div key={d.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-extrabold text-zinc-900 dark:text-zinc-100">{d.docNo}</span>
                        <span className="text-xs text-zinc-500">{fmtDate(d.date)}</span>
                        <span className="ms-auto num text-lg font-black text-zinc-900 dark:text-zinc-100">{fmtMoney(d.netTotalPaisa)}</span>
                      </div>
                      <div className="mt-2 flex items-center gap-3 text-sm">
                        <span className="text-zinc-500">{t("portal.paid")}: <b className="num text-zinc-700 dark:text-zinc-300">{fmtMoney(d.amountPaidPaisa)}</b></span>
                        <span className={out > 0n ? "font-extrabold text-emerald-700 dark:text-emerald-400" : "text-zinc-500"}>
                          {t("portal.due")}: <b className="num">{fmtMoney(out.toString())}</b>
                        </span>
                      </div>
                      {out > 0n && canOrder && (
                        <button className="btn btn-primary mt-3 w-full text-sm no-print" onClick={() => openIntentModal(d)}>
                          <Wallet size={15} /> {t("portal.payNow")}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {tab === "requests" && (
              <div className="mt-4 space-y-3">
                {canOrder && !showForm && (
                  <button className="btn btn-primary w-full no-print" onClick={() => setShowForm(true)}>
                    <Plus size={16} /> {isSupplier ? t("portal.submitInvoice") : t("portal.newOrder")}
                  </button>
                )}
                {showForm && (
                  <div className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                    <h3 className="font-extrabold text-zinc-900 dark:text-zinc-100">{isSupplier ? t("portal.submitInvoice") : t("portal.newRequest")}</h3>
                    {isSupplier && (
                      <div className="mt-3">
                        <Field label={t("portal.invoiceNo")}>
                          <input className="field" value={vendorRef} onChange={(e) => setVendorRef(e.target.value)} placeholder={t("portal.invoiceNoPlaceholder")} />
                        </Field>
                      </div>
                    )}
                    <div className="mt-3 space-y-2">
                      {isSupplier ? freeLines.map((l, i) => (
                        <div key={i} className="grid grid-cols-[1fr_64px_96px_32px] items-end gap-2">
                          <Field label={i === 0 ? t("portal.details") : ""}>
                            <input className="field" value={l.description} onChange={(e) => setFreeLines(freeLines.map((x, j) => j === i ? { ...x, description: e.target.value } : x))} />
                          </Field>
                          <Field label={i === 0 ? t("portal.qty") : ""}>
                            <input className="field" type="number" min={1} value={l.qty} onChange={(e) => setFreeLines(freeLines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                          </Field>
                          <Field label={i === 0 ? t("portal.rate") : ""}>
                            <input className="field num" type="number" min={0} value={l.rate} onChange={(e) => setFreeLines(freeLines.map((x, j) => j === i ? { ...x, rate: e.target.value } : x))} />
                          </Field>
                          <button className="btn btn-ghost !p-2" onClick={() => setFreeLines(freeLines.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
                        </div>
                      )) : lines.map((l, i) => (
                        <div key={i} className="grid grid-cols-[1fr_80px_32px] items-end gap-2">
                          <Field label={i === 0 ? t("portal.product") : ""}>
                            <select className="field" value={l.productId} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, productId: e.target.value } : x))}>
                              <option value="">—</option>
                              {products.map((p) => <option key={p.id} value={p.id}>{p.name} — {fmtMoney(p.salePrice)}</option>)}
                            </select>
                          </Field>
                          <Field label={i === 0 ? t("portal.qty") : ""}>
                            <input className="field" type="number" min={1} value={l.qty} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                          </Field>
                          <button className="btn btn-ghost !p-2" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 size={15} /></button>
                        </div>
                      ))}
                    </div>
                    <button className="mt-2 text-sm font-bold text-emerald-700 hover:underline dark:text-emerald-400" onClick={() =>
                      isSupplier ? setFreeLines([...freeLines, { description: "", qty: "1", rate: "" }]) : setLines([...lines, { productId: "", qty: "1" }])
                    }>
                      + {t("portal.addItem")}
                    </button>
                    {!isSupplier && (
                      <div className="mt-3">
                        <Field label={t("portal.notes")}>
                          <textarea className="field" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={t("portal.notesPlaceholder")} />
                        </Field>
                      </div>
                    )}
                    <div className="mt-4 flex flex-wrap justify-end gap-2">
                      <button className="btn btn-ghost" onClick={() => setShowForm(false)}>{t("common.cancel")}</button>
                      <button className="btn border border-zinc-300 dark:border-zinc-700" disabled={formBusy} onClick={() => submitRequest(true)}>{t("portal.saveDraft")}</button>
                      <button className="btn btn-primary" disabled={formBusy} onClick={() => submitRequest(false)}>
                        {formBusy ? t("common.saving") : t("portal.submitForApproval")}
                      </button>
                    </div>
                  </div>
                )}
                {requests.length === 0 && !showForm ? (
                  <div className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
                    <EmptyState title={t("portal.noRequests")} />
                  </div>
                ) : requests.map((r) => (
                  <div key={r.id} className="rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-extrabold">{r.requestNo}</span>
                      <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">{t(`portal.${r.status}`)}</span>
                      <span className="ms-auto num font-extrabold">{fmtMoney(r.grandTotalPaisa)}</span>
                    </div>
                    {r.vendorRef && <div className="mt-1 text-sm text-zinc-500">{t("portal.invoiceNo")}: {r.vendorRef}</div>}
                    {r.rejectionReason && <div className="mt-1 text-sm text-red-600 dark:text-red-400">{t("portal.rejectionReason")}: {r.rejectionReason}</div>}
                    <div className="mt-2 flex flex-wrap gap-2 no-print">
                      {r.status === "DRAFT" && canOrder && (
                        <button className="btn btn-primary text-sm" onClick={() => submitRequestSubmit(r.id)}>{t("portal.submitForApproval")}</button>
                      )}
                      {(r.status === "DRAFT" || r.status === "SUBMITTED") && canCancel && (
                        <button className="btn btn-ghost text-sm" onClick={() => cancelRequest(r.id)}>{t("portal.cancelRequest")}</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "payments" && (
              <div className="mt-4 space-y-3">
                <div className="rounded-2xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-200">
                  {t("portal.intentHint")}
                </div>
                {intents.length === 0 ? (
                  <div className="rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
                    <EmptyState title={t("portal.noIntents")} />
                  </div>
                ) : intents.map((i) => (
                  <div key={i.id} className="flex flex-wrap items-center gap-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="num font-extrabold">{fmtMoney(i.amountPaisa)}</span>
                        <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-bold text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                          {t(`portal.${i.status === "INTENT" ? "INTENT" : i.status}`)}
                        </span>
                      </div>
                      <div className="mt-0.5 text-sm text-zinc-500">{i.method}{i.reference ? ` · ${i.reference}` : ""} · {fmtDate(new Date(i.createdAt).toISOString())}</div>
                    </div>
                    {i.status === "INTENT" && canCancel && (
                      <button className="btn btn-ghost text-sm no-print" onClick={() => cancelIntent(i.id)}>{t("portal.cancelIntent")}</button>
                    )}
                  </div>
                ))}
              </div>
            )}

            {tab === "statement" && (
              <div className="mt-4">
                <div className="no-print grid grid-cols-[1fr_1fr_auto] items-end gap-2 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                  <Field label={t("portal.statementFrom")}><input className="field" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
                  <Field label={t("portal.statementTo")}><input className="field" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
                  <button className="btn btn-primary" disabled={stmtBusy || !from || !to} onClick={loadStatement}>{t("portal.statementShow")}</button>
                </div>
                {stmt && (
                  <div className="mt-3 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
                    <div className="mb-3 flex items-center justify-between">
                      <div>
                        <div className="text-sm text-zinc-500">{t("portal.openingBalance")}: <b className="num text-zinc-800 dark:text-zinc-200">{fmtMoney(stmt.openingPaisa)}</b></div>
                        <div className="text-sm text-zinc-500">{t("portal.closingBalance")}: <b className="num text-zinc-800 dark:text-zinc-200">{fmtMoney(stmt.closingPaisa)}</b></div>
                      </div>
                      <button className="btn border border-zinc-300 text-sm no-print dark:border-zinc-700" onClick={() => window.print()}>
                        <Printer size={15} /> {t("portal.printPdf")}
                      </button>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="tbl">
                        <thead><tr><th>{t("portal.date")}</th><th>{t("portal.details")}</th><th className="num">{t("portal.debit")}</th><th className="num">{t("portal.credit")}</th></tr></thead>
                        <tbody>
                          {stmt.lines.map((l, i) => (
                            <tr key={i}>
                              <td className="whitespace-nowrap">{fmtDate(l.date)}</td>
                              <td>{l.docNo ? `${l.docNo} — ` : ""}{l.description}</td>
                              <td className="num">{BigInt(l.debitPaisa) !== 0n ? fmtMoney(l.debitPaisa) : "—"}</td>
                              <td className="num">{BigInt(l.creditPaisa) !== 0n ? fmtMoney(l.creditPaisa) : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {/* Compromised-link self-revoke */}
        <div className="no-print mt-8 rounded-2xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
          <button className="flex items-center gap-2 text-sm font-bold text-red-600 hover:underline dark:text-red-400" onClick={revokeOwn}>
            <ShieldAlert size={15} /> {t("portal.revokeOwnLink")}
          </button>
        </div>
      </main>

      {intentDoc && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setIntentDoc(null)}>
          <div className="w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-extrabold text-zinc-900 dark:text-zinc-100">{t("portal.recordIntent")}</h3>
            <p className="mt-1 text-sm text-zinc-500">{t("portal.intentHint")}</p>
            <div className="mt-3 rounded-xl bg-zinc-100 p-3 text-sm dark:bg-zinc-800">
              <div className="flex justify-between"><span className="text-zinc-500">{t("portal.docNo")}</span><b>{intentDoc.docNo}</b></div>
              <div className="flex justify-between"><span className="text-zinc-500">{t("portal.due")}</span><b className="num">{fmtMoney(outstanding(intentDoc).toString())}</b></div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <Field label={t("portal.amount")}>
                <input className="field num" type="number" min={1} step="0.01" value={intentAmount} onChange={(e) => setIntentAmount(e.target.value)} dir="ltr" />
              </Field>
              <Field label={t("portal.method")}>
                <select className="field" value={intentMethod} onChange={(e) => setIntentMethod(e.target.value)}>
                  {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                </select>
              </Field>
            </div>
            <div className="mt-3">
              <Field label={t("portal.reference")}>
                <input className="field" value={intentRef} onChange={(e) => setIntentRef(e.target.value)} placeholder="TRX-123456" dir="ltr" />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setIntentDoc(null)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={intentBusy} onClick={submitIntent}>
                {intentBusy ? t("common.saving") : t("portal.recordIntent")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
