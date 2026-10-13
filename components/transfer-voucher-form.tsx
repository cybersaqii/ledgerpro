"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Trash2, ChevronDown } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { api, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { useDismiss } from "@/components/use-dismiss";
import { NumericDateInput } from "@/components/numeric-date-input";

/** Backend has no mode field for transfers — shown for FA parity, folded into notes. */
const MODES = [
  { value: "CASH", en: "Cash", ur: "نقد" },
  { value: "CHEQUE", en: "Cheque", ur: "چیک" },
  { value: "ONLINE", en: "Online", ur: "آن لائن" },
  { value: "BANK", en: "Bank Transfer", ur: "بینک ٹرانسفر" },
] as const;

type Bank = { id: string; name: string; kind: string };

type Row = {
  key: string;
  date: string;
  fromBankId: string;
  refNo: string;
  mode: string;
  toBankId: string;
  details: string;
  amount: string;
};

function newRow(): Row {
  return {
    key: crypto.randomUUID(),
    date: fmtDateInput(),
    fromBankId: "",
    refNo: "",
    mode: "BANK",
    toBankId: "",
    details: "",
    amount: "",
  };
}

export function TransferVoucherForm() {
  const router = useRouter();
  const { t, lang } = useLang();

  const [banks, setBanks] = useState<Bank[]>([]);
  const [rows, setRows] = useState<Row[]>([newRow()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useDismiss<HTMLDivElement>(() => setMenuOpen(false));
  const idemRef = useRef<string | null>(null);

  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks").then((d) => {
      setBanks(d.data);
      if (d.data[0]) setRows((rs) => rs.map((r) => ({ ...r, fromBankId: r.fromBankId || d.data[0].id })));
      if (d.data[1]) setRows((rs) => rs.map((r) => ({ ...r, toBankId: r.toBankId || d.data[1].id })));
    }).catch(() => {});
  }, []);

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const removeRow = (key: string) =>
    setRows((rs) => (rs.length > 1 ? rs.filter((r) => r.key !== key) : rs));

  const total = rows.reduce((s, r) => s + (parseFloat(r.amount || "0") || 0), 0);
  const modeLabel = (m: (typeof MODES)[number]) => (lang === "ur" ? m.ur : m.en);

  async function submit(after: "close" | "another") {
    setError(null);
    const valid = rows.filter(
      (r) => r.fromBankId && r.toBankId && r.fromBankId !== r.toBankId && parseFloat(r.amount || "0") > 0
    );
    if (valid.length === 0) { setError(t("bankvoucher.trErrRows")); return; }
    setSaving(true);
    try {
      idemRef.current ??= crypto.randomUUID();
      for (const r of valid) {
        const modeEn = MODES.find((m) => m.value === r.mode)?.en ?? "";
        const noteBits = [
          r.refNo ? `Ref: ${r.refNo}` : "",
          modeEn ? `Mode: ${modeEn}` : "",
          r.details,
        ].filter(Boolean);
        await api("/api/transfers", {
          method: "POST",
          body: JSON.stringify({
            fromBankAccountId: r.fromBankId,
            toBankAccountId: r.toBankId,
            date: r.date,
            amount: r.amount,
            notes: noteBits.join(" · ") || undefined,
            idempotencyKey: `${idemRef.current}-${r.key}`,
          }),
        });
      }
      idemRef.current = null;
      if (after === "another") { setRows([newRow()]); setSaving(false); }
      else router.push("/bank/transfers");
    } catch (err) {
      setError(err instanceof Error ? err.message : t("bankvoucher.errSave"));
      setSaving(false);
    }
  }

  const bankOpts = (exclude: string) =>
    banks.filter((b) => b.id !== exclude).map((b) => (
      <option key={b.id} value={b.id}>{b.name}</option>
    ));

  return (
    <div className="text-xs">
      <PageHeader title={t("bankvoucher.addTransferTitle")} />
      <ErrorNote message={error} />

      {/* Desktop table */}
      <div className="hidden overflow-x-auto sm:block">
        <table className="tbl-fa">
          <thead>
            <tr>
              <th>{t("bankvoucher.colDate")} *</th>
              <th>{t("bankvoucher.colFromBank")} *</th>
              <th>{t("bankvoucher.colRefNo")}</th>
              <th>{t("bankvoucher.colMode")}</th>
              <th>{t("bankvoucher.colToBank")} *</th>
              <th>{t("bankvoucher.colDetails")}</th>
              <th className="num">{t("bankvoucher.colAmount")} *</th>
              <th className="!w-10" aria-label={t("common.delete")} />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="!w-36">
                  <NumericDateInput
                    className="field !py-1"
                    value={r.date}
                    onChange={(v) => updateRow(r.key, { date: v })}
                    required
                  />
                </td>
                <td className="min-w-40">
                  <select className="field !py-1" required value={r.fromBankId}
                    onChange={(e) => updateRow(r.key, { fromBankId: e.target.value })}>
                    <option value="">{t("bankvoucher.selectBank")}</option>
                    {bankOpts(r.toBankId)}
                  </select>
                </td>
                <td className="!w-28">
                  <input className="field !py-1" value={r.refNo}
                    onChange={(e) => updateRow(r.key, { refNo: e.target.value })} />
                </td>
                <td className="!w-32">
                  <select className="field !py-1" value={r.mode}
                    onChange={(e) => updateRow(r.key, { mode: e.target.value })}>
                    {MODES.map((m) => <option key={m.value} value={m.value}>{modeLabel(m)}</option>)}
                  </select>
                </td>
                <td className="min-w-40">
                  <select className="field !py-1" required value={r.toBankId}
                    onChange={(e) => updateRow(r.key, { toBankId: e.target.value })}>
                    <option value="">{t("bankvoucher.selectBank")}</option>
                    {bankOpts(r.fromBankId)}
                  </select>
                </td>
                <td className="min-w-36">
                  <input className="field !py-1" value={r.details}
                    onChange={(e) => updateRow(r.key, { details: e.target.value })} />
                </td>
                <td className="!w-32">
                  <input className="field num !py-1" type="number" min="0" step="0.01" required
                    placeholder="0.00" value={r.amount}
                    onChange={(e) => updateRow(r.key, { amount: e.target.value })} />
                </td>
                <td className="!w-10 text-center">
                  <button type="button" onClick={() => removeRow(r.key)}
                    className="grid h-8 w-8 place-items-center rounded text-danger hover:bg-danger-soft"
                    aria-label={t("common.delete")}>
                    <Trash2 size={15} />
                  </button>
                </td>
              </tr>
            ))}
            <tr>
              <td colSpan={6} className="!py-1.5 text-end text-xs font-extrabold">{t("bankvoucher.total")}</td>
              <td className="num !py-1.5 text-xs font-extrabold tabular-nums">
                {total.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-2 sm:hidden">
        {rows.map((r, i) => (
          <div key={r.key} className="rounded border border-border bg-muted/40 p-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-bold text-muted-foreground">{t("bankvoucher.rowN", { n: i + 1 })}</p>
              <button type="button" onClick={() => removeRow(r.key)}
                className="grid h-8 w-8 place-items-center rounded text-danger hover:bg-danger-soft"
                aria-label={t("common.delete")}>
                <Trash2 size={15} />
              </button>
            </div>
            <div className="mt-1 grid grid-cols-2 gap-2">
              <NumericDateInput
                className="field"
                value={r.date}
                onChange={(v) => updateRow(r.key, { date: v })}
                aria-label={t("bankvoucher.colDate")}
              />
              <select className="field" aria-label={t("bankvoucher.colMode")} value={r.mode}
                onChange={(e) => updateRow(r.key, { mode: e.target.value })}>
                {MODES.map((m) => <option key={m.value} value={m.value}>{modeLabel(m)}</option>)}
              </select>
              <select className="field col-span-2" aria-label={t("bankvoucher.colFromBank")} value={r.fromBankId}
                onChange={(e) => updateRow(r.key, { fromBankId: e.target.value })}>
                <option value="">{t("bankvoucher.colFromBank")}</option>
                {bankOpts(r.toBankId)}
              </select>
              <select className="field col-span-2" aria-label={t("bankvoucher.colToBank")} value={r.toBankId}
                onChange={(e) => updateRow(r.key, { toBankId: e.target.value })}>
                <option value="">{t("bankvoucher.colToBank")}</option>
                {bankOpts(r.fromBankId)}
              </select>
              <input className="field" placeholder={t("bankvoucher.colRefNo")} aria-label={t("bankvoucher.colRefNo")} value={r.refNo}
                onChange={(e) => updateRow(r.key, { refNo: e.target.value })} />
              <input className="field num" type="number" min="0" step="0.01" placeholder="0.00"
                aria-label={t("bankvoucher.colAmount")} value={r.amount}
                onChange={(e) => updateRow(r.key, { amount: e.target.value })} />
              <input className="field col-span-2" placeholder={t("bankvoucher.colDetails")}
                aria-label={t("bankvoucher.colDetails")} value={r.details}
                onChange={(e) => updateRow(r.key, { details: e.target.value })} />
            </div>
          </div>
        ))}
        <div className="flex items-center justify-between rounded border border-border px-3 py-2 text-xs font-extrabold">
          <span>{t("bankvoucher.total")}</span>
          <span className="tabular-nums">{total.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
        </div>
      </div>

      {/* + Add More */}
      <button type="button" onClick={() => setRows((rs) => [...rs, newRow()])}
        className="mt-2 inline-flex items-center gap-1.5 rounded-full border border-primary px-4 py-1.5 text-xs font-bold text-primary transition hover:bg-primary hover:text-primary-foreground">
        <Plus size={14} /> {t("bankvoucher.addMore")}
      </button>

      {/* Bottom bar */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <button type="button" onClick={() => router.back()}
          className="rounded-full border border-primary px-5 py-2 text-xs font-bold text-primary transition hover:bg-primary-soft">
          {t("common.cancel")}
        </button>
        <div className="relative" ref={menuRef}>
          <div className="flex">
            <button type="button" disabled={saving} onClick={() => submit("close")}
              className="rounded-s-full bg-green-600 px-5 py-2 text-xs font-bold text-white transition hover:bg-green-700 disabled:opacity-60">
              {saving ? t("common.saving") : t("bankvoucher.approveAndClose")}
            </button>
            <button type="button" onClick={() => setMenuOpen((o) => !o)}
              className="grid w-9 place-items-center rounded-e-full border-s border-white/30 bg-green-600 text-white transition hover:bg-green-700"
              aria-label={t("bankvoucher.moreActions")} aria-expanded={menuOpen}>
              <ChevronDown size={15} />
            </button>
          </div>
          {menuOpen && (
            <div className="absolute bottom-full end-0 z-20 mb-1 w-52 overflow-hidden rounded-xl border border-border bg-card shadow-xl">
              <button type="button" disabled={saving}
                onClick={() => { setMenuOpen(false); submit("another"); }}
                className="block w-full px-4 py-2.5 text-start text-xs font-semibold hover:bg-muted">
                {t("bankvoucher.approveAndAddAnother")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
