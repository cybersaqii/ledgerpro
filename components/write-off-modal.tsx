"use client";

import { useEffect, useRef, useState } from "react";
import { Modal } from "@/components/modal";
import { Field, ErrorNote } from "@/components/ui";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Account = { id: string; name: string; code: string };

/** Bad-debt write-off modal: Dr Bad Debts / Cr AR on an overdue invoice. */
export function WriteOffModal({
  partyId, docId, outstanding, onClose, onDone,
}: {
  partyId: string; docId: string; outstanding: bigint;
  onClose: () => void; onDone: () => void;
}) {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState({ accountId: "", date: fmtDateInput(), amount: "", notes: "" });
  // One idempotency key per user submission: kept across save attempts so a
  // retry after a network blip replays instead of double-creating. Cleared
  // on success so the next write-off gets a fresh key.
  const idemRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Account[] }>("/api/accounts?type=EXPENSE")
      .then((a) => {
        setAccounts(a.data);
        const general = a.data.find((x) => x.code === "6000") ?? a.data[0];
        if (general) setForm((x) => ({ ...x, accountId: general.id }));
      })
      .catch(() => {});
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      // One idempotency key per user submission (kept across retries so a
      // retry after a network blip replays instead of double-creating).
      idemRef.current ??= crypto.randomUUID();
      await api(`/api/parties/${partyId}/write-off`, {
        method: "POST",
        body: JSON.stringify({
          salesDocId: docId,
          accountId: form.accountId,
          date: form.date,
          amount: form.amount,
          notes: form.notes,
          idempotencyKey: idemRef.current,
        }),
      });
      idemRef.current = null;
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not write off.");
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((x) => ({ ...x, [k]: e.target.value }));

  return (
    <Modal title={f("fix3.woTitle")} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote message={error} />
        <p className="text-sm text-muted-foreground">
          {f("fix3.woOutstanding")}: <strong className="text-foreground">{fmtMoney(outstanding)}</strong>
        </p>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={f("fix3.woDate")}>
            <input type="date" className="field" required value={form.date} onChange={set("date")} />
          </Field>
          <Field label={f("fix3.woAmount")}>
            <input className="field num" type="number" min="0" step="0.01" required
              max={Number(outstanding) / 100} value={form.amount} onChange={set("amount")} placeholder="0.00" />
          </Field>
        </div>
        <Field label={f("fix3.woAccount")} hint={f("fix3.woAccountHint")}>
          <select className="field" required value={form.accountId} onChange={set("accountId")}>
            <option value="">—</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <Field label={f("fix3.woNotes")}>
          <input className="field" value={form.notes} onChange={set("notes")} placeholder={f("fix3.woNotesPh")} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={saving || !(parseFloat(form.amount) > 0)}>
            {saving ? t("common.saving") : f("fix3.woSave")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Recover a written-off invoice: find the unrecovered write-off for the
 * doc and post the exact reversal. */
export async function recoverWriteOff(partyId: string, docId: string): Promise<void> {
  const w = await api<{ data: { id: string; salesDocId: string; recoveredAt: number | null }[] }>(
    `/api/parties/${partyId}/write-off`
  );
  const rec = w.data.find((r) => r.salesDocId === docId && !r.recoveredAt);
  if (!rec) throw new Error("No open write-off found for this invoice.");
  await api(`/api/write-offs/${rec.id}/recover`, { method: "POST" });
}
