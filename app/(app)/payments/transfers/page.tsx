"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Plus, ArrowLeftRight } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote, Pagination } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type TransferRow = {
  id: string; docNo: string; date: number;
  fromBankAccountId: string; toBankAccountId: string;
  fromName: string | null; toName: string | null;
  amount: string; notes: string | null;
};
type Bank = { id: string; name: string; kind: string };

const PER_PAGE = 20;

export default function TransfersPage() {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");

  const [rows, setRows] = useState<TransferRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  const [modal, setModal] = useState(false);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [form, setForm] = useState({ fromBankAccountId: "", toBankAccountId: "", date: fmtDateInput(), amount: "", notes: "" });
  // One idempotency key per user submission: kept across save attempts so a
  // retry after a network blip replays instead of double-creating. Cleared
  // on success so the next transfer gets a fresh key.
  const idemRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: TransferRow[]; total: number }>(`/api/transfers?page=${page}&perPage=${PER_PAGE}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/page change
  useEffect(() => { load(); }, [load]);

  async function openModal() {
    setError(null);
    setForm({ fromBankAccountId: "", toBankAccountId: "", date: fmtDateInput(), amount: "", notes: "" });
    try {
      const b = await api<{ data: Bank[] }>("/api/banks");
      setBanks(b.data);
      if (b.data[0]) setForm((x) => ({ ...x, fromBankAccountId: b.data[0].id }));
      if (b.data[1]) setForm((x) => ({ ...x, toBankAccountId: b.data[1].id }));
    } catch { /* ignore */ }
    setModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // One idempotency key per user submission (kept across retries so a
      // retry after a network blip replays instead of double-creating).
      idemRef.current ??= crypto.randomUUID();
      await api("/api/transfers", { method: "POST", body: JSON.stringify({ ...form, idempotencyKey: idemRef.current }) });
      idemRef.current = null;
      setModal(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((x) => ({ ...x, [k]: e.target.value }));

  return (
    <div>
      <PageHeader
        title={f("fix3.trTitle")}
        subtitle={f("fix3.trSubtitle")}
        icon={<ArrowLeftRight size={20} />}
        actions={canPost ? (
          <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {f("fix3.trNew")}</button>
        ) : undefined}
      />

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={f("fix3.trEmpty")} hint={f("fix3.trEmptyHint")}
            action={canPost ? <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {f("fix3.trNew")}</button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{f("fix3.trColDoc")}</th><th>{f("fix3.trColDate")}</th>
                <th>{f("fix3.trColFrom")}</th><th>{f("fix3.trColTo")}</th>
                <th className="num">{f("fix3.trColAmount")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-bold whitespace-nowrap">{r.docNo}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                    <td>{r.fromName ?? "—"}</td>
                    <td>{r.toName ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />

      {modal && (
        <Modal title={f("fix3.trNew")} onClose={() => setModal(false)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={f("fix3.trFrom")}>
                <select className="field" required value={form.fromBankAccountId} onChange={set("fromBankAccountId")}>
                  <option value="">—</option>
                  {banks.filter((b) => b.id !== form.toBankAccountId).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={f("fix3.trTo")}>
                <select className="field" required value={form.toBankAccountId} onChange={set("toBankAccountId")}>
                  <option value="">—</option>
                  {banks.filter((b) => b.id !== form.fromBankAccountId).map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={f("fix3.trDate")}>
                <input type="date" className="field" required value={form.date} onChange={set("date")} />
              </Field>
              <Field label={f("fix3.trAmount")}>
                <input className="field num" type="number" min="0" step="0.01" required
                  value={form.amount} onChange={set("amount")} placeholder="0.00" />
              </Field>
            </div>
            <Field label={f("fix3.trNotes")}>
              <input className="field" value={form.notes} onChange={set("notes")} placeholder={f("fix3.trNotesPh")} />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>
                {saving ? t("common.saving") : f("fix3.trSave")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
