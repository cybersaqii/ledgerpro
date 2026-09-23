"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, Suspense } from "react";
import { Landmark } from "lucide-react";
import { PageHeader, Field, ErrorNote } from "@/components/ui";
import { api, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Party = { id: string; name: string };

function RecordPdcFormInner() {
  const router = useRouter();
  const { t } = useLang();
  const [kind, setKind] = useState<"RECEIVED" | "ISSUED">("RECEIVED");
  const isReceived = kind === "RECEIVED";
  const partyKind = isReceived ? "CUSTOMER" : "SUPPLIER";

  const [parties, setParties] = useState<Party[]>([]);
  const [partyQ, setPartyQ] = useState("");
  const [partyId, setPartyId] = useState("");
  const [showPartyList, setShowPartyList] = useState(false);
  const [chequeNo, setChequeNo] = useState("");
  const [bankName, setBankName] = useState("");
  const [amount, setAmount] = useState("");
  const [chequeDate, setChequeDate] = useState(fmtDateInput());
  const [refNo, setRefNo] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const tm = setTimeout(async () => {
      try {
        const d = await api<{ data: Party[] }>(`/api/parties?kind=${partyKind}&q=${encodeURIComponent(partyQ)}&perPage=20`);
        setParties(d.data);
      } catch { /* ignore */ }
    }, 250);
    return () => clearTimeout(tm);
  }, [partyQ, partyKind]);

  const selectedParty = parties.find((p) => p.id === partyId) ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!partyId) { setError(t("pdcform.errParty", { party: t(partyKind === "CUSTOMER" ? "pdcform.customer" : "pdcform.supplier").toLowerCase() })); return; }
    if (!chequeNo.trim()) { setError(t("pdcform.errChequeNo")); return; }
    if (!(parseFloat(amount || "0") > 0)) { setError(t("pdcform.errAmount")); return; }
    if (!chequeDate) { setError(t("pdcform.errDate")); return; }
    setSaving(true);
    try {
      await api("/api/pdc", {
        method: "POST",
        body: JSON.stringify({
          kind, partyId, chequeNo: chequeNo.trim(),
          bankName: bankName.trim() || undefined, amount,
          chequeDate, refNo: refNo.trim() || undefined, notes: notes.trim() || undefined,
        }),
      });
      router.push("/payments/pdc");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pdcform.errSave"));
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("pdcform.title")} subtitle={t("pdcform.subtitle")} icon={<Landmark size={20} />} />
      <form onSubmit={submit} className="mx-auto max-w-2xl space-y-5">
        <ErrorNote message={error} />
        <div className="card p-5 sm:p-6">
          <div className="mb-5 flex rounded-xl border border-border bg-muted/60 p-1">
            {(["RECEIVED", "ISSUED"] as const).map((k) => (
              <button key={k} type="button" onClick={() => { setKind(k); setPartyId(""); }}
                className={`flex-1 rounded-lg px-4 py-2.5 text-sm font-bold transition ${kind === k ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}>
                {k === "RECEIVED" ? t("pdcform.kindReceived") : t("pdcform.kindIssued")}
              </button>
            ))}
          </div>
          <p className="mb-5 text-xs text-muted-foreground">{isReceived ? t("pdcform.kindReceivedHint") : t("pdcform.kindIssuedHint")}</p>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t(partyKind === "CUSTOMER" ? "pdcform.customer" : "pdcform.supplier")}>
              <div className="relative">
                <button type="button" onClick={() => setShowPartyList((s) => !s)} className="field flex items-center justify-between text-left">
                  <span className={selectedParty ? "" : "text-muted-foreground"}>
                    {selectedParty ? selectedParty.name : t("pdcform.selectPlaceholder")}
                  </span>
                </button>
                {showPartyList && (
                  <div className="absolute z-20 mt-1 w-full overflow-hidden rounded-xl border border-border bg-card shadow-xl">
                    <div className="border-b border-border p-2">
                      <input autoFocus className="field !py-2" placeholder={t("pdcform.searchPlaceholder")}
                        value={partyQ} onChange={(e) => setPartyQ(e.target.value)} />
                    </div>
                    <ul className="max-h-56 overflow-y-auto py-1">
                      {parties.map((p) => (
                        <li key={p.id}>
                          <button type="button" className="block w-full px-4 py-2.5 text-left text-sm hover:bg-muted"
                            onClick={() => { setPartyId(p.id); setShowPartyList(false); }}>{p.name}</button>
                        </li>
                      ))}
                      {parties.length === 0 && <li className="px-4 py-3 text-sm text-muted-foreground">{t("pdcform.noMatches")}</li>}
                    </ul>
                  </div>
                )}
              </div>
            </Field>
            <Field label={t("pdcform.chequeNo")}>
              <input className="field" value={chequeNo} onChange={(e) => setChequeNo(e.target.value)}
                required maxLength={40} placeholder={t("pdcform.chequeNoPlaceholder")} />
            </Field>
            <Field label={t("pdcform.bankName")}>
              <input className="field" value={bankName} onChange={(e) => setBankName(e.target.value)}
                maxLength={80} placeholder={t("pdcform.bankNamePlaceholder")} />
            </Field>
            <Field label={t("pdcform.amount")}>
              <input className="field num text-lg font-extrabold" type="number" min="0" step="0.01" required
                placeholder="0.00" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label={t("pdcform.chequeDate")}>
              <input type="date" className="field" required value={chequeDate} onChange={(e) => setChequeDate(e.target.value)} />
            </Field>
            <Field label={t("pdcform.refNo")}>
              <input className="field" value={refNo} onChange={(e) => setRefNo(e.target.value)}
                maxLength={60} placeholder={t("pdcform.refNoPlaceholder")} />
            </Field>
          </div>
          <div className="mt-4">
            <Field label={t("pdcform.notes")}>
              <input className="field" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} />
            </Field>
          </div>
        </div>

        <button className="btn btn-primary w-full !py-3.5 !text-base" disabled={saving}>
          {saving ? t("pdcform.saving") : t("pdcform.save")}
        </button>
      </form>
    </div>
  );
}

export default function RecordPdcPage() {
  return (
    <Suspense fallback={<div className="card h-64 animate-pulse" />}>
      <RecordPdcFormInner />
    </Suspense>
  );
}
