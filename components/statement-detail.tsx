"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Trash2, Unlink, Wand2, Plus } from "lucide-react";
import { ErrorNote, Field } from "@/components/ui";
import { Modal } from "@/components/modal";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

export type StmtLine = {
  id: string; date: number; description: string; reference: string | null;
  debit: string; credit: string; amount: string;
  isDuplicate: boolean; matchedJournalLineId: string | null;
  createdTxnType: string | null; createdTxnId: string | null;
};
export type GlLine = { lineId: string; date: number; memo: string; reference: string | null; amount: string };
export type StmtDetail = {
  statement: { id: string; fileName: string; lineCount: number; createdAt: number };
  account: { id: string; name: string; kind: string };
  lines: StmtLine[];
  glLines: GlLine[];
  matchedCount: number;
  reconciled: boolean;
  difference: string;
};

type Account = { id: string; name: string; code: string; type: string };
type Bank = { id: string; name: string };

type SpawnKind = "EXPENSE" | "RECEIPT" | "TRANSFER";

export function StatementDetail({
  bankId,
  statementId,
  canPost,
  onDeleted,
}: {
  bankId: string;
  statementId: string;
  canPost: boolean;
  onDeleted: () => void;
}) {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const [detail, setDetail] = useState<StmtDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [matchSel, setMatchSel] = useState<Record<string, string>>({});
  const [spawn, setSpawn] = useState<{ kind: SpawnKind; line: StmtLine } | null>(null);
  const [adj, setAdj] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Account/bank lists for the spawn forms — fetched once per detail mount.
  const [expAccounts, setExpAccounts] = useState<Account[]>([]);
  const [incAccounts, setIncAccounts] = useState<Account[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ data: StmtDetail }>(`/api/bank-accounts/${bankId}/statements/${statementId}`);
      setDetail(d.data);
    } catch (err) {
      setDetail(null);
      setError(err instanceof Error ? err.message : m("errImport"));
    } finally {
      setLoading(false);
    }
  }, [bankId, statementId, m]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/statement change
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    Promise.all([
      api<{ data: Account[] }>("/api/accounts?type=EXPENSE").catch(() => ({ data: [] as Account[] })),
      api<{ data: Account[] }>("/api/accounts?type=INCOME").catch(() => ({ data: [] as Account[] })),
      api<{ data: Account[] }>("/api/accounts?type=ASSET").catch(() => ({ data: [] as Account[] })),
      api<{ data: Bank[] }>("/api/banks").catch(() => ({ data: [] as Bank[] })),
    ]).then(([e, inc, ast, b]) => {
      setExpAccounts(e.data);
      setIncAccounts([...inc.data, ...ast.data.filter((a) => !/^10\d{2}$/.test(a.code))]);
      setBanks(b.data);
    });
  }, []);

  async function autoMatch() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const d = await api<{ data: { matched: number; total: number } }>(
        `/api/bank-accounts/${bankId}/statements/${statementId}`,
        { method: "POST", body: JSON.stringify({ action: "auto-match" }) }
      );
      setMsg(m("autoMatchResult", { matched: d.data.matched, total: d.data.total }));
      setMatchSel({});
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errMatch"));
    } finally {
      setBusy(false);
    }
  }

  async function match(lineId: string) {
    const journalLineId = matchSel[lineId];
    if (!journalLineId || busy) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      await api(`/api/bank-accounts/${bankId}/statements/${statementId}`, {
        method: "POST",
        body: JSON.stringify({ action: "match", lineId, journalLineId }),
      });
      setMatchSel((s) => { const n = { ...s }; delete n[lineId]; return n; });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errMatch"));
    } finally {
      setBusy(false);
    }
  }

  async function unmatch(lineId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/bank-accounts/${bankId}/statements/${statementId}`, {
        method: "POST",
        body: JSON.stringify({ action: "unmatch", lineIds: [lineId] }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errMatch"));
    } finally {
      setBusy(false);
    }
  }

  async function doDelete() {
    if (deleting) return;
    setDeleting(true);
    try {
      await api(`/api/bank-accounts/${bankId}/statements/${statementId}`, { method: "DELETE" });
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errImport"));
    } finally {
      setDeleting(false);
    }
  }

  function glLabel(g: GlLine) {
    const amt = BigInt(g.amount);
    return `${fmtDate(g.date)} · ${g.memo || "—"} · ${amt >= 0n ? "+" : ""}${fmtMoney(g.amount)}`;
  }

  if (loading || !detail) {
    return (
      <div className="card p-8">
        {loading ? (
          <div className="space-y-3">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : (
          <ErrorNote message={error} />
        )}
      </div>
    );
  }

  const unmatchedGl = detail.glLines;
  const diffZero = BigInt(detail.difference) === 0n;

  return (
    <div>
      <ErrorNote message={error} />
      {msg && (
        <div className="mb-4 rounded-xl border border-success/40 bg-success-soft px-4 py-3 text-sm font-semibold text-success">
          {msg}
        </div>
      )}

      {/* Statement header */}
      <div className="card mb-4 flex flex-wrap items-center gap-3 p-4">
        <div className="min-w-0 flex-1">
          <p className="truncate text-base font-extrabold">{detail.statement.fileName}</p>
          <p className="text-xs text-muted-foreground">
            {m("lineCount", { count: detail.statement.lineCount })} · {m("matched")}: {detail.matchedCount}
            {" · "}{detail.account.name}
          </p>
        </div>
        <span className={`badge ${detail.reconciled ? "bg-success/15 text-success" : "bg-warning/15 text-warning"}`}>
          {detail.reconciled ? m("stmtReconciled") : m("stmtPending")}
        </span>
        {!diffZero && (
          <span className="text-sm font-bold text-warning">
            {t("fix4.recon.difference")}: {fmtMoney(detail.difference)}
          </span>
        )}
        {canPost && (
          <>
            <button className="btn btn-primary text-sm" disabled={busy} onClick={autoMatch}>
              <Wand2 size={15} /> {busy ? t("fix4.recon.working") : m("autoMatch")}
            </button>
            <button className="btn btn-ghost text-sm" onClick={() => setAdj(true)}>
              <Plus size={15} /> {m("recordAdj")}
            </button>
            <button className="btn btn-ghost text-sm text-danger" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={15} /> {m("deleteStmt")}
            </button>
          </>
        )}
      </div>

      {/* Split view: statement lines vs ledger entries */}
      <div className="grid gap-4 lg:grid-cols-[1.5fr_1fr]">
        <div className="card overflow-hidden">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-extrabold">{m("stmtLines")}</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="tbl min-w-[640px]">
              <thead><tr>
                <th>{m("colStmtDate")}</th><th>{m("colStmtDesc")}</th>
                <th className="num">{m("colMoneyOut")}</th><th className="num">{m("colMoneyIn")}</th>
                <th>{m("colStatus")}</th>
              </tr></thead>
              <tbody>
                {detail.lines.map((l) => {
                  const matched = l.matchedJournalLineId != null;
                  return (
                    <tr key={l.id} className={matched ? "opacity-70" : ""}>
                      <td className="whitespace-nowrap text-muted-foreground">{fmtDate(l.date)}</td>
                      <td className="min-w-44">
                        <div className="font-semibold">{l.description || "—"}</div>
                        {l.reference && <div className="text-xs text-muted-foreground" dir="ltr">{l.reference}</div>}
                      </td>
                      <td className="num">{BigInt(l.debit) !== 0n ? fmtMoney(l.debit) : "—"}</td>
                      <td className="num">{BigInt(l.credit) !== 0n ? fmtMoney(l.credit) : "—"}</td>
                      <td>
                        {l.isDuplicate ? (
                          <span className="badge bg-muted text-muted-foreground">{m("duplicate")}</span>
                        ) : matched ? (
                          <div className="flex items-center gap-2">
                            <span className="badge bg-success/15 text-success">
                              {m("matched")}{l.createdTxnType ? ` · ${l.createdTxnType}` : ""}
                            </span>
                            {canPost && (
                              <button
                                className="btn btn-ghost !min-h-11 !min-w-11 !p-2 text-muted-foreground hover:text-danger"
                                title={m("unmatchBtn")}
                                onClick={() => unmatch(l.id)}
                              >
                                <Unlink size={14} />
                              </button>
                            )}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="badge bg-warning/15 text-warning">{m("unmatched")}</span>
                            {canPost && (
                              <div className="flex flex-wrap items-center gap-1">
                                <select
                                  className="field !w-40 !py-1 text-xs"
                                  value={matchSel[l.id] ?? ""}
                                  onChange={(e) => setMatchSel((s) => ({ ...s, [l.id]: e.target.value }))}
                                  aria-label={m("selectGl")}
                                >
                                  <option value="">{m("selectGl")}</option>
                                  {unmatchedGl.map((g) => (
                                    <option key={g.lineId} value={g.lineId}>{glLabel(g)}</option>
                                  ))}
                                </select>
                                <button
                                  className="btn btn-ghost !px-2 !py-1 text-xs font-bold text-primary"
                                  disabled={!matchSel[l.id] || busy}
                                  onClick={() => match(l.id)}
                                >
                                  {m("matchBtn")}
                                </button>
                                {BigInt(l.debit) !== 0n && (
                                  <button
                                    className="btn btn-ghost !px-2 !py-1 text-xs font-bold"
                                    title={m("spawnExpense")}
                                    onClick={() => setSpawn({ kind: "EXPENSE", line: l })}
                                  >
                                    {m("spawnExpense")}
                                  </button>
                                )}
                                {BigInt(l.credit) !== 0n && (
                                  <button
                                    className="btn btn-ghost !px-2 !py-1 text-xs font-bold"
                                    title={m("spawnReceipt")}
                                    onClick={() => setSpawn({ kind: "RECEIPT", line: l })}
                                  >
                                    {m("spawnReceipt")}
                                  </button>
                                )}
                                <button
                                  className="btn btn-ghost !px-2 !py-1 text-xs font-bold"
                                  title={m("spawnTransfer")}
                                  onClick={() => setSpawn({ kind: "TRANSFER", line: l })}
                                >
                                  {m("spawnTransfer")}
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card overflow-hidden self-start">
          <div className="border-b border-border px-4 py-3">
            <h3 className="text-sm font-extrabold">{m("glLines")} ({unmatchedGl.length})</h3>
          </div>
          <div className="max-h-[560px] overflow-y-auto">
            {unmatchedGl.length === 0 ? (
              <p className="p-4 text-sm text-muted-foreground">{m("unmatched")}: 0</p>
            ) : (
              <ul className="divide-y divide-border">
                {unmatchedGl.map((g) => {
                  const amt = BigInt(g.amount);
                  return (
                    <li key={g.lineId} className="px-4 py-2.5">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="text-xs text-muted-foreground">{fmtDate(g.date)}</span>
                        <span className={`num text-sm font-extrabold ${amt >= 0n ? "text-primary" : "text-accent"}`}>
                          {amt >= 0n ? "+" : ""}{fmtMoney(g.amount)}
                        </span>
                      </div>
                      <p className="truncate text-sm font-semibold">{g.memo || "—"}</p>
                      {g.reference && <p className="truncate text-xs text-muted-foreground" dir="ltr">{g.reference}</p>}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>

      {spawn && (
        <SpawnModal
          kind={spawn.kind}
          line={spawn.line}
          bankId={bankId}
          expAccounts={expAccounts}
          incAccounts={incAccounts}
          banks={banks}
          onClose={() => setSpawn(null)}
          onDone={() => { setSpawn(null); setMatchSel({}); load(); }}
        />
      )}

      {adj && (
        <AdjustmentModal
          bankId={bankId}
          onClose={() => setAdj(false)}
          onDone={async () => { setAdj(false); await autoMatch(); }}
        />
      )}

      {confirmDelete && (
        <Modal title={m("deleteStmt")} onClose={() => setConfirmDelete(false)}>
          <p className="text-sm">{m("deleteStmtConfirm", { count: detail.statement.lineCount })}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost text-sm" onClick={() => setConfirmDelete(false)}>{t("common.cancel")}</button>
            <button className="btn btn-danger text-sm" disabled={deleting} onClick={doDelete}>
              {deleting ? t("common.deleting") : t("common.delete")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ─── Spawn a transaction from a statement line ───

function SpawnModal({
  kind, line, bankId, expAccounts, incAccounts, banks, onClose, onDone,
}: {
  kind: SpawnKind;
  line: StmtLine;
  bankId: string;
  expAccounts: Account[];
  incAccounts: Account[];
  banks: Bank[];
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const idemRef = useRef<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const out = BigInt(line.debit) !== 0n;
  const signedAmt = BigInt(line.amount);
  const absAmt = (signedAmt < 0n ? -signedAmt : signedAmt).toString();

  const [form, setForm] = useState({
    accountId: "",
    otherBankId: "",
    date: fmtDateInput(new Date(line.date)),
    amount: (Number(absAmt) / 100).toFixed(2),
    fee: "",
    notes: line.description || "",
  });

  const title = kind === "EXPENSE" ? m("spawnExpense") : kind === "RECEIPT" ? m("spawnReceipt") : m("spawnTransfer");
  const accounts = kind === "EXPENSE" ? expAccounts : kind === "RECEIPT" ? incAccounts : [];

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      idemRef.current ??= crypto.randomUUID();
      const payload = { idempotencyKey: idemRef.current, statementLineId: line.id };
      if (kind === "EXPENSE") {
        await api("/api/expenses", {
          method: "POST",
          body: JSON.stringify({
            ...payload,
            accountId: form.accountId,
            bankAccountId: bankId,
            date: form.date,
            amount: form.amount,
            notes: form.notes,
          }),
        });
      } else if (kind === "RECEIPT") {
        await api("/api/sundry-receipts", {
          method: "POST",
          body: JSON.stringify({
            ...payload,
            accountId: form.accountId,
            bankAccountId: bankId,
            date: form.date,
            amount: form.amount,
            notes: form.notes,
          }),
        });
      } else {
        await api("/api/transfers", {
          method: "POST",
          body: JSON.stringify({
            ...payload,
            // Money out of this account = transfer FROM here; money in = transfer TO here.
            fromBankAccountId: out ? bankId : form.otherBankId,
            toBankAccountId: out ? form.otherBankId : bankId,
            date: form.date,
            amount: form.amount,
            fee: form.fee || undefined,
            notes: form.notes,
          }),
        });
      }
      idemRef.current = null;
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errSaveReceipt"));
    } finally {
      setSaving(false);
    }
  }

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote message={error} />
        <p className="text-xs text-muted-foreground">
          {m("colStmtDate")}: {fmtDate(line.date)} · {out ? m("colMoneyOut") : m("colMoneyIn")}: {fmtMoney(absAmt)}
        </p>
        {kind !== "TRANSFER" ? (
          <Field label={kind === "EXPENSE" ? t("expenses.expenseAccount") : m("creditAccount")}>
            <select className="field" required value={form.accountId} onChange={set("accountId")}>
              <option value="">—</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>{a.name} ({a.code})</option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={out ? t("fix3.trTo") : t("fix3.trFrom")}>
            <select className="field" required value={form.otherBankId} onChange={set("otherBankId")}>
              <option value="">—</option>
              {banks.filter((b) => b.id !== bankId).map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={m("colDate")}>
            <input type="date" className="field" required value={form.date} onChange={set("date")} />
          </Field>
          <Field label={m("colAmount")}>
            <input className="field num" type="number" min="0" step="0.01" required
              value={form.amount} onChange={set("amount")} />
          </Field>
        </div>
        {kind === "TRANSFER" && (
          <Field label={m("fee")} hint={m("feeHint")}>
            <input className="field num" type="number" min="0" step="0.01" value={form.fee} onChange={set("fee")} placeholder="0.00" />
          </Field>
        )}
        <Field label={t("payform.detailNotes")}>
          <input className="field" value={form.notes} onChange={set("notes")} maxLength={500} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ─── One-click bank charge / interest modal ───

export function AdjustmentModal({
  bankId, onClose, onDone,
}: {
  bankId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const idemRef = useRef<string | null>(null);
  const [form, setForm] = useState({
    kind: "CHARGE" as "CHARGE" | "INTEREST",
    date: fmtDateInput(),
    amount: "",
    notes: "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      idemRef.current ??= crypto.randomUUID();
      await api(`/api/bank-accounts/${bankId}/adjustments`, {
        method: "POST",
        body: JSON.stringify({ ...form, idempotencyKey: idemRef.current }),
      });
      idemRef.current = null;
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errAdj"));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={m("adjTitle")} onClose={onClose}>
      <form onSubmit={save} className="space-y-4">
        <ErrorNote message={error} />
        <div className="grid grid-cols-2 gap-2">
          {(["CHARGE", "INTEREST"] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setForm((f) => ({ ...f, kind: k }))}
              className={`rounded-xl border px-3 py-2.5 text-sm font-bold transition ${
                form.kind === k ? "border-primary bg-primary-soft text-primary" : "border-border text-muted-foreground"
              }`}
            >
              {k === "CHARGE" ? m("adjCharge") : m("adjInterest")}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={m("adjDate")}>
            <input type="date" className="field" required value={form.date}
              onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))} />
          </Field>
          <Field label={m("adjAmount")}>
            <input className="field num" type="number" min="0" step="0.01" required value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))} placeholder="0.00" />
          </Field>
        </div>
        <Field label={m("adjNotes")}>
          <input className="field" value={form.notes} maxLength={500}
            onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
        </Field>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" className="btn btn-ghost" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary" disabled={saving}>
            {saving ? t("common.saving") : t("common.save")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
