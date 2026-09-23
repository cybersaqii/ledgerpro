"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState, Suspense } from "react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { parseDecimalToPaisa } from "@/lib/decimal";
import { useLang } from "@/components/lang-provider";

type Party = { id: string; name: string };
type Bank = { id: string; name: string; kind: string };
type Outstanding = { id: string; docNo: string; docType: string; date: number; grandTotal: string; balance: string };

function PaymentFormInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const { t } = useLang();
  const [kind, setKind] = useState<"RECEIPT" | "PAYMENT">(sp.get("kind") === "PAYMENT" ? "PAYMENT" : "RECEIPT");
  const [payPartyKind, setPayPartyKind] = useState<"CUSTOMER" | "SUPPLIER">("SUPPLIER");
  const isReceipt = kind === "RECEIPT";

  const [parties, setParties] = useState<Party[]>([]);
  const [partyQ, setPartyQ] = useState("");
  const [partyId, setPartyId] = useState(sp.get("partyId") ?? "");
  const [showPartyList, setShowPartyList] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [date, setDate] = useState(fmtDateInput());
  const [amount, setAmount] = useState(() => sp.get("amount") ?? "");
  const [method, setMethod] = useState("CASH");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [outstanding, setOutstanding] = useState<Outstanding[]>([]);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // "Make Payment" deep link pre-fill: ?allocateDocId=&amount= — applied once
  // the outstanding list for the pre-selected party finishes loading.
  const [prefill] = useState(() => ({ docId: sp.get("allocateDocId") ?? "", amount: sp.get("amount") ?? "" }));
  const prefillApplied = useRef(false);

  const partyKind = isReceipt ? "CUSTOMER" : payPartyKind;
  const isRefund = !isReceipt && partyKind === "CUSTOMER"; // customer refund: plain ledger movement, no allocation

  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks").then((d) => {
      setBanks(d.data);
      const cash = d.data.find((b) => b.kind === "CASH");
      if (cash) setBankId(cash.id);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const d = await api<{ data: Party[] }>(`/api/parties?kind=${partyKind}&q=${encodeURIComponent(partyQ)}&perPage=20`);
        setParties(d.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(t);
  }, [partyQ, partyKind]);

  // load outstanding bills when party changes
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- data fetch on party change */
    setOutstanding([]);
    setAlloc({});
    if (!partyId || isRefund) return;
    api<{ data: Outstanding[] }>(`/api/parties/${partyId}/outstanding?kind=${isReceipt ? "SALES" : "PURCHASE"}`)
      .then((d) => setOutstanding(d.data))
      .catch(() => {});
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [partyId, isReceipt, isRefund]);

  // apply the "Make Payment" deep-link pre-fill once outstanding docs load
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- one-time pre-fill after docs load */
    if (prefillApplied.current || !prefill.docId || outstanding.length === 0) return;
    const row = outstanding.find((o) => o.id === prefill.docId);
    if (!row) return;
    prefillApplied.current = true;
    let want = 0n;
    try { want = parseDecimalToPaisa(prefill.amount.trim() || "0"); } catch { want = 0n; }
    if (want <= 0n) return;
    const cap = BigInt(row.balance);
    const fill = want < cap ? want : cap;
    setAlloc({ [row.id]: `${fill / 100n}.${(fill % 100n).toString().padStart(2, "0")}` });
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [outstanding, prefill]);

  const selectedParty = parties.find((p) => p.id === partyId) ?? (partyId ? { id: partyId, name: "Selected" } : null);
  const allocTotal = Object.values(alloc).reduce((a, v) => a + Math.round(parseFloat(v || "0") * 100), 0);
  const amountPaisa = Math.round(parseFloat(amount || "0") * 100);

  function toggleAlloc(id: string, balance: string) {
    setAlloc((a) => {
      const next = { ...a };
      if (next[id]) delete next[id];
      else {
        // default: remaining amount after other allocations, capped by bill balance
        const others = Object.entries(next).reduce((s, [, v]) => s + Math.round(parseFloat(v || "0") * 100), 0);
        const remaining = Math.max(0, amountPaisa - others);
        const fill = Math.min(remaining, Number(BigInt(balance)));
        next[id] = (fill / 100).toString();
      }
      return next;
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!partyId) { setError(t("payform.errParty", { party: t(partyKind === "CUSTOMER" ? "payform.customer" : "payform.supplier").toLowerCase() })); return; }
    if (!bankId) { setError(t("payform.errAccount")); return; }
    if (!(parseFloat(amount || "0") > 0)) { setError(t("payform.errAmount")); return; }
    if (allocTotal > amountPaisa) { setError(t("payform.errAlloc")); return; }
    setSaving(true);
    try {
      await api("/api/payments", {
        method: "POST",
        body: JSON.stringify({
          kind, partyId, bankAccountId: bankId, date, amount,
          method, reference: reference || undefined, notes: notes || undefined,
          allocations: isRefund ? [] : Object.entries(alloc)
            .filter(([, v]) => parseFloat(v || "0") > 0)
            .map(([docId, v]) => ({ docId, docKind: isReceipt ? "SALES" : "PURCHASE", amount: v })),
        }),
      });
      router.push("/payments");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("payform.errSave"));
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title={isReceipt ? t("payform.receiveTitle") : t("payform.payTitle")}
        subtitle={isReceipt ? t("payform.receiveSub") : t("payform.paySub")} />
      <form onSubmit={submit} className="mx-auto max-w-2xl space-y-5">
        <ErrorNote message={error} />

        <div className="card p-5 sm:p-6">
          <div className="mb-5 flex rounded-xl border border-border bg-muted/60 p-1">
            {(["RECEIPT", "PAYMENT"] as const).map((k) => (
              <button key={k} type="button" onClick={() => { setKind(k); setPartyId(""); }}
                className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-bold transition ${kind === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
                {k === "RECEIPT" ? t("payform.tabReceive") : t("payform.tabPay")}
              </button>
            ))}
          </div>
          {!isReceipt && (
            <div className="mb-5 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2">
              <span className="text-xs font-semibold text-muted-foreground">{t("payform.payTo")}</span>
              <div className="flex flex-1 gap-1">
                {(["SUPPLIER", "CUSTOMER"] as const).map((k) => (
                  <button key={k} type="button" onClick={() => { setPayPartyKind(k); setPartyId(""); }}
                    className={`flex-1 rounded-lg px-3 py-1.5 text-xs font-bold transition ${payPartyKind === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
                    {k === "SUPPLIER" ? t("payform.supplier") : t("payform.customer")}
                  </button>
                ))}
              </div>
              {isRefund && <span className="text-xs text-muted-foreground">{t("payform.refundHint")}</span>}
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t(partyKind === "CUSTOMER" ? "payform.customer" : "payform.supplier")}>
              <div className="relative">
                <button type="button" onClick={() => setShowPartyList((s) => !s)} className="field flex items-center justify-between text-left">
                  <span className={selectedParty ? "" : "text-muted-foreground"}>{selectedParty ? selectedParty.name : t("payform.selectPlaceholder")}</span>
                </button>
                {showPartyList && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="border-b border-border p-2">
                      <input autoFocus className="field !py-2" placeholder={t("payform.searchPlaceholder")} value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                    </div>
                    <ul className="max-h-56 overflow-y-auto py-1">
                      {parties.map((p) => (
                        <li key={p.id}>
                          <button type="button" className="block w-full px-4 py-2.5 text-left text-sm hover:bg-muted"
                            onClick={() => { setPartyId(p.id); setShowPartyList(false); }}>{p.name}</button>
                        </li>
                      ))}
                      {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">{t("payform.noMatches")}</li>}
                    </ul>
                  </div>
                )}
              </div>
            </Field>
            <Field label={t("payform.account")}>
              <select className="field" value={bankId} onChange={(e) => setBankId(e.target.value)} required>
                <option value="">{t("payform.selectAccount")}</option>
                {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label={t("payform.date")}><input type="date" className="field" required value={date} onChange={(e) => setDate(e.target.value)} /></Field>
            <Field label={t("payform.amount")}>
              <input className="field num text-lg font-extrabold" type="number" min="0" step="0.01" required
                placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label={t("payform.method")}>
              <select className="field" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="CASH">{t("payform.methodCash")}</option>
                <option value="BANK">{t("payform.methodBank")}</option>
                <option value="CHEQUE">{t("payform.methodCheque")}</option>
                <option value="ONLINE">{t("payform.methodOnline")}</option>
              </select>
            </Field>
            <Field label={t("payform.reference")}><input className="field" value={reference} onChange={(e) => setReference(e.target.value)} placeholder={t("payform.referencePlaceholder")} /></Field>
          </div>
          <div className="mt-4">
            <Field label={t("payform.notes")}><input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
          </div>
        </div>

        {outstanding.length > 0 && (
          <div className="card p-5 sm:p-6">
            <h2 className="text-base font-bold">{t("payform.allocateTitle")}</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {t("payform.allocateSummary", { count: outstanding.length, allocated: `Rs ${(allocTotal / 100).toLocaleString()}`, total: `Rs ${(amountPaisa / 100).toLocaleString() || "0"}` })}
            </p>
            <ul className="mt-4 space-y-2">
              {outstanding.map((o) => (
                <li key={o.id} className={`flex items-center gap-3 rounded-xl border p-3 ${alloc[o.id] ? "border-primary bg-primary-soft/40" : "border-border"}`}>
                  <input type="checkbox" checked={!!alloc[o.id]} onChange={() => toggleAlloc(o.id, o.balance)}
                    aria-label={t("payform.allocateAgainst", { docNo: o.docNo })}
                    className="h-6 w-6 shrink-0 accent-[var(--primary)]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold">{o.docNo}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(o.date)} · {t("payform.due", { balance: fmtMoney(o.balance) })}</p>
                  </div>
                  {alloc[o.id] !== undefined && (
                    <input className="field num !w-28 !py-1.5" type="number" min="0" step="0.01"
                      max={(Number(BigInt(o.balance)) / 100).toString()}
                      value={alloc[o.id]} onChange={(e) => setAlloc((a) => ({ ...a, [o.id]: e.target.value }))} />
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <button className="btn btn-primary w-full !py-3.5 !text-base" disabled={saving}>
          {saving ? t("payform.saving") : isReceipt ? t("payform.saveReceipt") : t("payform.savePayment")}
        </button>
      </form>
    </div>
  );
}

export default function NewPaymentPage() {
  return (
    <Suspense fallback={<div className="card h-64 animate-pulse" />}>
      <PaymentFormInner />
    </Suspense>
  );
}
