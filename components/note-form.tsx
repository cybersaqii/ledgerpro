"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ReceiptText, TriangleAlert } from "lucide-react";
import { PageHeader, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtDateInput } from "@/lib/format";

type Opt = { id: string; name: string };
type Account = { id: string; name: string; code: string };
type Doc = { id: string; docNo: string };

/**
 * New credit/debit note form (amount-only, no item lines).
 * kind=CREDIT -> customer, posts Dr discount/variance / Cr AR.
 * kind=DEBIT  -> supplier, posts Dr AP / Cr discount/variance.
 */
export function NoteForm({ kind }: { kind: "CREDIT" | "DEBIT" }) {
  const { t } = useLang();
  const router = useRouter();
  const isCredit = kind === "CREDIT";
  const [parties, setParties] = useState<Opt[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [partyId, setPartyId] = useState("");
  const [date, setDate] = useState(fmtDateInput());
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState("");
  const [sourceDocId, setSourceDocId] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Opt[] }>(`/api/parties?kind=${isCredit ? "CUSTOMER" : "SUPPLIER"}&perPage=200`)
      .then((d) => setParties(d.data))
      .catch(() => {});
    api<{ data: Account[] }>(`/api/accounts?type=${isCredit ? "EXPENSE" : "INCOME"}`)
      .then((d) => {
        setAccounts(d.data);
        const defCode = isCredit ? "5010" : "4010"; // Discount Given / Discount Received
        const def = d.data.find((a) => a.code === defCode);
        if (def) setAccountId(def.id);
      })
      .catch(() => {});
  }, [isCredit]);

  useEffect(() => {
    if (!partyId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset doc picker when the party changes
      setDocs([]);
      setSourceDocId("");
      return;
    }
    const base = isCredit ? "/api/sales" : "/api/purchases";
    api<{ data: Doc[] }>(`${base}?docType=${isCredit ? "INVOICE" : "BILL"}&partyId=${partyId}&perPage=100`)
      .then((d) => setDocs(d.data))
      .catch(() => {});
  }, [partyId, isCredit]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ data: { id: string } }>("/api/notes", {
        method: "POST",
        body: JSON.stringify({
          kind,
          partyId,
          date,
          amount,
          accountId: accountId || undefined,
          sourceDocId: sourceDocId || undefined,
          notes: notes || undefined,
        }),
      });
      router.push(`${isCredit ? "/sales" : "/purchases"}/notes/${d.data.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("fix4.note.errSave"));
      setBusy(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t(isCredit ? "fix4.note.newCreditTitle" : "fix4.note.newDebitTitle")}
        subtitle={t("fix4.note.newSubtitle")}
        icon={<ReceiptText size={20} />}
      />
      <form onSubmit={submit} className="card mx-auto max-w-2xl space-y-4 p-5 sm:p-8">
        {error && (
          <div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger-soft p-3 text-sm font-semibold text-danger">
            <TriangleAlert size={16} /> {error}
          </div>
        )}
        <Field label={t(isCredit ? "fix4.note.customer" : "fix4.note.supplier")}>
          <select className="field" value={partyId} onChange={(e) => setPartyId(e.target.value)} required>
            <option value="">{t("fix4.note.selectParty")}</option>
            {parties.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("fix4.note.date")}>
            <input type="date" className="field" value={date} onChange={(e) => setDate(e.target.value)} required />
          </Field>
          <Field label={t("fix4.note.amount")}>
            <input
              className="field text-right"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </Field>
        </div>
        <Field label={t("fix4.note.account")}>
          <select className="field" value={accountId} onChange={(e) => setAccountId(e.target.value)} required>
            <option value="">{t("fix4.note.selectAccount")}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name} ({a.code})</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{t("fix4.note.accountHint")}</p>
        </Field>
        <Field label={t("fix4.note.sourceDoc")}>
          <select className="field" value={sourceDocId} onChange={(e) => setSourceDocId(e.target.value)}>
            <option value="">{t("fix4.note.noSourceDoc")}</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>{d.docNo}</option>
            ))}
          </select>
          <p className="mt-1 text-xs text-muted-foreground">{t("fix4.note.sourceDocHint")}</p>
        </Field>
        <Field label={t("fix4.note.notes")}>
          <textarea className="field min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={() => router.back()} disabled={busy}>
            {t("common.cancel")}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? t("fix4.note.posting") : t("fix4.note.postNote")}
          </button>
        </div>
      </form>
    </div>
  );
}
