"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import { PageHeader, EmptyState, Field, ErrorNote } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Expense = {
  id: string; date: number; amount: string; taxAmount: string; notes: string | null;
  accountName: string | null; bankName: string | null;
};
type Account = { id: string; name: string; code: string };
type Bank = { id: string; name: string };

export default function ExpensesPage() {
  const [rows, setRows] = useState<Expense[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [form, setForm] = useState({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", taxAmount: "0", notes: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: Expense[]; total: number }>("/api/expenses?perPage=30");
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  async function openModal() {
    setError(null);
    setForm({ accountId: "", bankAccountId: "", date: fmtDateInput(), amount: "", taxAmount: "0", notes: "" });
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
      setError(err instanceof Error ? err.message : "Could not save.");
    } finally { setSaving(false); }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div>
      <PageHeader
        title="Expenses"
        subtitle={`${total} expenses recorded`}
        actions={<button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> Add expense</button>}
      />

      <div className="card overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="h-12 animate-pulse rounded-xl bg-muted" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title="No expenses yet" hint="Record rent, salaries, fuel and other business expenses."
            action={<button className="btn btn-primary text-sm" onClick={openModal}><Plus size={16} /> Add now</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr><th>Date</th><th>Account</th><th>Paid from</th><th>Notes</th><th className="num">Amount</th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.id}>
                    <td className="text-muted-foreground">{fmtDate(x.date)}</td>
                    <td className="font-bold">{x.accountName ?? "—"}</td>
                    <td className="text-muted-foreground">{x.bankName ?? "—"}</td>
                    <td className="max-w-52 truncate text-muted-foreground">{x.notes ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney((BigInt(x.amount) + BigInt(x.taxAmount)).toString())}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <Modal title="Add expense" onClose={() => setModal(false)}>
          <form onSubmit={save} className="space-y-4">
            <ErrorNote message={error} />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Expense account">
                <select className="field" required value={form.accountId} onChange={set("accountId")}>
                  <option value="">Select…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </Field>
              <Field label="Paid from">
                <select className="field" required value={form.bankAccountId} onChange={set("bankAccountId")}>
                  <option value="">Select…</option>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label="Date"><input type="date" className="field" required value={form.date} onChange={set("date")} /></Field>
              <Field label="Amount (Rs)"><input className="field num" type="number" min="0" step="0.01" required value={form.amount} onChange={set("amount")} placeholder="0.00" /></Field>
            </div>
            <Field label="Notes (optional)"><input className="field" value={form.notes} onChange={set("notes")} placeholder="e.g. Shop rent for September" /></Field>
            <div className="flex justify-end gap-2 pt-2">
              <button type="button" className="btn btn-ghost" onClick={() => setModal(false)}>Cancel</button>
              <button className="btn btn-primary" disabled={saving}>{saving ? "Saving…" : "Save expense"}</button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
