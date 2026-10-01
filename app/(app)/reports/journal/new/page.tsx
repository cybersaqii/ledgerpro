"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ReceiptText, CheckCircle2 } from "lucide-react";
import { PageHeader, ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Account = { id: string; code: string; name: string; type: string; isActive: boolean };
type Party = { id: string; name: string; kind: string };
type Line = { key: number; accountId: string; debit: string; credit: string; partyId: string; memo: string };

let keySeq = 1;
const blankLine = (): Line => ({ key: keySeq++, accountId: "", debit: "", credit: "", partyId: "", memo: "" });

function toPaisa(v: string): bigint {
  const s = v.trim();
  if (!s) return 0n;
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(s)) return 0n;
  const [w, f = ""] = s.split(".");
  return BigInt(w) * 100n + BigInt((f + "00").slice(0, 2));
}

export default function NewJournalVoucherPage() {
  const { t } = useLang();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState<Line[]>([blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Account[] }>("/api/accounts").then((d) => setAccounts(d.data)).catch(() => {});
    Promise.all([
      api<{ data: Party[] }>("/api/parties?kind=CUSTOMER&perPage=100"),
      api<{ data: Party[] }>("/api/parties?kind=SUPPLIER&perPage=100"),
    ]).then(([c, s]) => setParties([...c.data, ...s.data])).catch(() => {});
  }, []);

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const totalDr = lines.reduce((a, l) => a + toPaisa(l.debit), 0n);
  const totalCr = lines.reduce((a, l) => a + toPaisa(l.credit), 0n);
  const diff = totalDr - totalCr;
  const validLines = lines.filter((l) => l.accountId && (toPaisa(l.debit) > 0n || toPaisa(l.credit) > 0n));
  const bothSides = lines.some((l) => toPaisa(l.debit) > 0n && toPaisa(l.credit) > 0n);
  const canSave =
    !saving && memo.trim().length > 0 && validLines.length >= 2 && diff === 0n && totalDr > 0n && !bothSides;

  async function save() {
    if (!canSave) return;
    setSaving(true); setError(null);
    try {
      const d = await api<{ data: { id: string; docNo: string } }>("/api/journal-vouchers", {
        method: "POST",
        headers: { "X-Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          date,
          memo: memo.trim(),
          lines: validLines.map((l) => ({
            accountId: l.accountId,
            debit: l.debit.trim() || "0",
            credit: l.credit.trim() || "0",
            partyId: l.partyId || null,
            memo: l.memo.trim() || undefined,
          })),
        }),
      });
      router.push(`/reports/journal?q=${encodeURIComponent(d.data.docNo)}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("jv.errSave"));
      setSaving(false);
    }
  }

  return (
    <div>
      <PageHeader
        title={t("jv.title")}
        subtitle={t("jv.subtitle")}
        icon={<ReceiptText size={20} />}
      />
      {error && <ErrorNote message={error} />}

      <div className="card rise rise-1 mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label={t("jv.date")} required>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="sm:col-span-2">
            <Field label={t("jv.memo")} required hint={t("jv.memoHint")}>
              <input className="input" value={memo} onChange={(e) => setMemo(e.target.value)} placeholder={t("jv.memoPh")} maxLength={500} />
            </Field>
          </div>
        </div>
      </div>

      <div className="card rise rise-2 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl min-w-[760px]">
            <thead>
              <tr>
                <th>{t("jv.colAccount")}</th>
                <th className="num">{t("jv.colDebit")}</th>
                <th className="num">{t("jv.colCredit")}</th>
                <th>{t("jv.colParty")}</th>
                <th>{t("jv.colLineMemo")}</th>
                <th className="!w-10" />
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.key}>
                  <td className="!py-1.5">
                    <select className="input !py-1.5" value={l.accountId} onChange={(e) => setLine(l.key, { accountId: e.target.value })}>
                      <option value="">{t("jv.selectAccount")}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                  </td>
                  <td className="!py-1.5">
                    <input
                      className="input num !py-1.5" inputMode="decimal" placeholder="0.00"
                      value={l.debit}
                      onChange={(e) => setLine(l.key, { debit: e.target.value, ...(e.target.value.trim() ? { credit: "" } : {}) })}
                    />
                  </td>
                  <td className="!py-1.5">
                    <input
                      className="input num !py-1.5" inputMode="decimal" placeholder="0.00"
                      value={l.credit}
                      onChange={(e) => setLine(l.key, { credit: e.target.value, ...(e.target.value.trim() ? { debit: "" } : {}) })}
                    />
                  </td>
                  <td className="!py-1.5">
                    <select className="input !py-1.5" value={l.partyId} onChange={(e) => setLine(l.key, { partyId: e.target.value })}>
                      <option value="">{t("jv.noParty")}</option>
                      {parties.map((p) => <option key={p.id} value={p.id}>{p.name} ({p.kind === "CUSTOMER" ? t("jv.customer") : t("jv.supplier")})</option>)}
                    </select>
                  </td>
                  <td className="!py-1.5">
                    <input className="input !py-1.5" value={l.memo} onChange={(e) => setLine(l.key, { memo: e.target.value })} placeholder={t("jv.lineMemoPh")} maxLength={200} />
                  </td>
                  <td className="!py-1.5 !text-end">
                    <button className="btn btn-ghost !p-2 text-danger" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} disabled={lines.length <= 2}>
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-border">
                <td className="!py-3 font-extrabold">{t("common.total")}</td>
                <td className="num !py-3 font-extrabold">{fmtMoney(totalDr)}</td>
                <td className="num !py-3 font-extrabold">{fmtMoney(totalCr)}</td>
                <td colSpan={3} className="!py-3">
                  {diff === 0n && totalDr > 0n ? (
                    <span className="badge bg-success-soft text-success"><CheckCircle2 size={12} />{t("jv.balanced")}</span>
                  ) : (
                    <span className="badge bg-danger-soft text-danger">{t("jv.diff", { amount: fmtMoney(diff < 0n ? -diff : diff) })}</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="flex items-center justify-between border-t border-border p-3">
          <button className="btn btn-ghost" onClick={() => setLines((ls) => [...ls, blankLine()])}>
            <Plus size={14} /> {t("jv.addLine")}
          </button>
          <span className="px-2 text-xs text-muted-foreground">{t("jv.strictHint")}</span>
        </div>
      </div>

      {bothSides && <div className="mt-3"><ErrorNote message={t("jv.errBothSides")} /></div>}

      <div className="sticky bottom-0 mt-4 flex justify-end gap-2 bg-background/80 py-3 backdrop-blur">
        <button className="btn btn-ghost" onClick={() => router.back()}>{t("common.cancel")}</button>
        <button className="btn btn-primary" onClick={save} disabled={!canSave}>
          {saving ? t("common.saving") : t("jv.saveVoucher")}
        </button>
      </div>
      {!canSave && !saving && (
        <p className="mt-1 text-end text-xs text-muted-foreground">{t("jv.saveHint")}</p>
      )}
    </div>
  );
}
