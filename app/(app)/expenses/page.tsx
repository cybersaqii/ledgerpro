"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, CalendarDays, ReceiptText } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote, FilterBar, SummaryChips, Pagination } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtDate, fmtDateInput, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Expense = {
  id: string; date: number; amount: string; taxAmount: string; notes: string | null;
  accountName: string | null; bankName: string | null;
};
type Account = { id: string; name: string; code: string };
type Bank = { id: string; name: string };

const PER_PAGE = 20;

export default function ExpensesPage() {
  const { t } = useLang();
  const [rows, setRows] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [sum, setSum] = useState("0");
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [accountId, setAccountId] = useState("");
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", taxAmount: "", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), perPage: String(PER_PAGE) });
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      if (accountId) params.set("accountId", accountId);
      const d = await api<{ data: Expense[]; total: number; sumTotal: string | number }>(`/api/expenses?${params.toString()}`);
      setRows(d.data);
      setTotal(d.total);
      setSum(String(d.sumTotal ?? "0"));
    } catch { setRows([]); } finally { setLoading(false); }
  }, [from, to, accountId, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [from, to, accountId]);

  useEffect(() => {
    api<{ data: Account[] }>("/api/accounts?type=EXPENSE").then((d) => setAccounts(d.data)).catch(() => {});
  }, []);

  const hasFilter = from !== "" || to !== "" || accountId !== "";

  async function openModal() {
    setError(null);
    setForm({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", taxAmount: "", notes: "" });
    try {
      const [a, b] = await Promise.all([
        api<{ data: Account[] }>("/api/accounts?type=EXPENSE"),
        api<{ data: Bank[] }>("/api/banks"),
      ]);
      setAccounts(a.data);
      setBanks(b.data);
      if (a.data[0]) setForm((f) => ({ ...f, accountId: a.data[0].id }));
      const cash = b.data.find((x) => x.name.toLowerCase().includes("cash"));
      if (cash) setForm((f) => ({ ...f, bankAccountId: cash.id }));
      else if (b.data[0]) setForm((f) => ({ ...f, bankAccountId: b.data[0].id }));
    } catch { /* ignore */ }
    setModal(true);
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true); setError(null);
    try {
      await api("/api/expenses", { method: "POST", body: JSON.stringify(form) });
      setModal(false);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("expenses.saveError"));
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageHeader
        title={t("expenses.title")}
        subtitle={t("expenses.subtitle")}
        icon={<ReceiptText size={20} />}
        actions={<button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {t("expenses.addExpense")}</button>}
      />

      <FilterBar>
        <select className="field !w-auto !py-2 text-xs font-semibold" value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label={t("expenses.accountFilter")}>
          <option value="">{t("expenses.allAccounts")}</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("payments.fromDate")} />
          <span className="text-xs text-muted-foreground">{t("payments.toWord")}</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("payments.toDate")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setFrom(""); setTo(""); setAccountId(""); }}>
            {t("expenses.clearFilters")}
          </button>
        )}
      </FilterBar>

      {!loading && (
        <SummaryChips items={[
          { label: t("expenses.sumCount"), value: total.toLocaleString() },
          { label: t("expenses.sumTotal"), value: fmtMoney(toBig(sum)), tone: "danger" },
        ]} />
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("expenses.emptyTitle")}
            hint={hasFilter ? t("expenses.emptyHintFilter") : t("expenses.emptyHint")}
            action={!hasFilter ? <button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> {t("expenses.addNow")}</button> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>{t("expenses.colDate")}</th><th>{t("expenses.colAccount")}</th><th>{t("expenses.colPaidFrom")}</th><th>{t("expenses.colNotes")}</th><th className="num">{t("expenses.colAmount")}</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(x.date)}</td>
                    <td><span className="badge bg-muted text-foreground">{x.accountName ?? "—"}</span></td>
                    <td className="text-muted-foreground">{x.bankName ?? "—"}</td>
                    <td className="max-w-52 truncate text-muted-foreground">{x.notes ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(toBig(x.amount) + toBig(x.taxAmount))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />

      {modal && (
        <Modal title={t("expenses.modalTitle")} onClose={() => setModal(false)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("expenses.expenseAccount")}>
                <select className="field" required value={form.accountId} onChange={set("accountId")}>
                  <option value="">{t("expenses.selectPlaceholder")}</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label={t("expenses.paidFrom")}>
                <select className="field" required value={form.bankAccountId} onChange={set("bankAccountId")}>
                  <option value="">{t("expenses.selectPlaceholder")}</option>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label={t("expenses.date")}><input type="date" className="field" required value={form.date} onChange={set("date")} /></Field>
              <Field label={t("expenses.amount")}><input className="field num" type="number" min="0" step="0.01" required value={form.amount} onChange={set("amount")} placeholder="0.00" /></Field>
            </div>
            <Field label={t("expenses.notes")}><input className="field" value={form.notes} onChange={set("notes")} placeholder={t("expenses.notesPlaceholder")} /></Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? t("common.saving") : t("expenses.saveExpense")}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
