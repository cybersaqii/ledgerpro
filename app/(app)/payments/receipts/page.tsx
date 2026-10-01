"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Plus, ArrowLeft, HandCoins, Ban } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote, Pagination } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type Receipt = {
  id: string; docNo: string; date: number; amount: string; notes: string | null;
  accountName: string | null; bankName: string | null; voidedAt: number | null;
};
type Account = { id: string; name: string; code: string; type: string };
type Bank = { id: string; name: string };

const PER_PAGE = 20;

export default function SundryReceiptsPage() {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");

  const [rows, setRows] = useState<Receipt[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", notes: "" });
  const idemRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<Receipt | null>(null);
  const [voidReason, setVoidReason] = useState("");
  const [voidError, setVoidError] = useState<string | null>(null);
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Receipt[]; total: number }>(`/api/sundry-receipts?page=${page}&perPage=${PER_PAGE}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/page change
  useEffect(() => { load(); }, [load]);

  async function openModal() {
    setError(null);
    setForm({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", notes: "" });
    try {
      const [inc, ast, b] = await Promise.all([
        api<{ data: Account[] }>("/api/accounts?type=INCOME"),
        api<{ data: Account[] }>("/api/accounts?type=ASSET"),
        api<{ data: Bank[] }>("/api/banks"),
      ]);
      // Income heads first, then asset accounts (e.g. advances) — exclude the
      // bank/cash GL accounts themselves to avoid a no-op receipt.
      const all = [...inc.data, ...ast.data.filter((a) => !/^10\d{2}$/.test(a.code))];
      setAccounts(all);
      setBanks(b.data);
      if (all[0]) setForm((f) => ({ ...f, accountId: all[0].id }));
      if (b.data[0]) setForm((f) => ({ ...f, bankAccountId: b.data[0].id }));
    } catch { /* ignore */ }
    setModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      idemRef.current ??= crypto.randomUUID();
      await api("/api/sundry-receipts", { method: "POST", body: JSON.stringify({ ...form, idempotencyKey: idemRef.current }) });
      idemRef.current = null;
      setModal(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errSaveReceipt"));
    } finally { setSaving(false); }
  }

  async function doVoid(e: React.FormEvent) {
    e.preventDefault();
    if (!voidTarget) return;
    setVoiding(true);
    setVoidError(null);
    try {
      await api(`/api/sundry-receipts/${voidTarget.id}/void`, { method: "POST", body: JSON.stringify({ reason: voidReason }) });
      setVoidTarget(null);
      setVoidReason("");
      load();
    } catch (err) {
      setVoidError(err instanceof Error ? err.message : m("errSaveReceipt"));
    } finally { setVoiding(false); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageHeader
        title={m("receiptsTitle")}
        subtitle={m("receiptsSubtitle")}
        icon={<HandCoins size={20} />}
        actions={
          <div className="flex gap-2">
            <Link href="/payments" className="btn btn-ghost text-sm">
              <ArrowLeft size={16} className="rtl:rotate-180" /> {t("banks.backToPayments")}
            </Link>
            {canPost && (
              <button className="btn btn-primary text-sm" onClick={openModal}>
                <Plus size={16} /> {m("newReceipt")}
              </button>
            )}
          </div>
        }
      />

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={m("receiptsTitle")} hint={m("receiptsSubtitle")}
            action={canPost ? <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {m("newReceipt")}</button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{m("colVoucher")}</th><th>{m("colDate")}</th>
                <th>{m("colCreditAccount")}</th><th>{m("colBank")}</th>
                <th className="num">{m("colAmount")}</th>
                {canPost && <th><span className="sr-only">{m("voidReceipt")}</span></th>}
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.voidedAt ? "opacity-60" : ""}>
                    <td className="font-bold whitespace-nowrap">{r.docNo}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                    <td>
                      <span className="badge bg-muted text-foreground">{r.accountName ?? "—"}</span>
                      {r.voidedAt && <span className="badge ms-1 bg-danger/15 text-danger">{m("voided")}</span>}
                    </td>
                    <td className="text-muted-foreground">{r.bankName ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(r.amount)}</td>
                    {canPost && (
                      <td className="text-end">
                        {!r.voidedAt && (
                          <button
                            className="btn btn-ghost !p-2 text-muted-foreground hover:text-danger"
                            title={m("voidReceipt")}
                            onClick={() => { setVoidTarget(r); setVoidReason(""); setVoidError(null); }}
                          >
                            <Ban size={15} />
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />

      {modal && (
        <Modal title={m("newReceipt")} onClose={() => setModal(false)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <Field label={m("creditAccount")} hint={m("creditAccountHint")}>
              <select className="field" required value={form.accountId} onChange={set("accountId")}>
                <option value="">—</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>{a.name} ({a.code})</option>
                ))}
              </select>
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={m("colBank")}>
                <select className="field" required value={form.bankAccountId} onChange={set("bankAccountId")}>
                  <option value="">—</option>
                  {banks.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </Field>
              <Field label={m("colDate")}>
                <input type="date" className="field" required value={form.date} onChange={set("date")} />
              </Field>
            </div>
            <Field label={m("colAmount")}>
              <input className="field num" type="number" min="0" step="0.01" required
                value={form.amount} onChange={set("amount")} placeholder="0.00" />
            </Field>
            <Field label={t("payform.detailNotes")}>
              <input className="field" value={form.notes} onChange={set("notes")} maxLength={500} />
            </Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>
                {saving ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {voidTarget && (
        <Modal title={m("voidReceipt")} onClose={() => setVoidTarget(null)}>
          <form onSubmit={doVoid} className="space-y-4">
            <ErrorNote message={voidError} />
            <p className="text-sm">{m("voidReceiptConfirm", { docNo: voidTarget.docNo })}</p>
            <Field label={t("payform.detailNotes")}>
              <input className="field" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} maxLength={500} />
            </Field>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost" onClick={() => setVoidTarget(null)}>{t("common.cancel")}</button>
              <button className="btn btn-danger" disabled={voiding}>
                {voiding ? t("common.deleting") : m("voidReceipt")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
