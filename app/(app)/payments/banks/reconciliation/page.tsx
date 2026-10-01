"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCheck, Landmark, TriangleAlert, RotateCcw, Undo2, FileSpreadsheet } from "lucide-react";
import { PageHeader, Field } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";
import { StatementDetail } from "@/components/statement-detail";

type Statement = { id: string; fileName: string; lineCount: number; createdAt: number };

type Bank = { id: string; name: string; kind: string };
type RecLine = {
  lineId: string; entryId: string; date: number; memo: string; reference: string | null;
  source: string; partyName: string | null; debit: string; credit: string;
  clearedAt: number | null; suggestedClearedAt: number | null;
};
type RecData = {
  account: { id: string; name: string; kind: string; bankName: string | null; accountNo: string | null };
  lines: RecLine[];
  bookBalance: string; clearedBalance: string; difference: string;
  clearedCount: number; totalCount: number;
};

export default function ReconciliationPage() {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");
  const [banks, setBanks] = useState<Bank[]>([]);
  const [accountId, setAccountId] = useState("");
  const [showCleared, setShowCleared] = useState(false);
  // Module 3: pick an imported statement to reconcile against (split view,
  // auto-match, charge/interest modal) on top of the manual clear/unclear UI.
  const [statements, setStatements] = useState<Statement[]>([]);
  const [statementId, setStatementId] = useState("");
  const [data, setData] = useState<RecData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [clearedAt, setClearedAt] = useState(fmtDateInput());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks")
      .then((d) => {
        setBanks(d.data);
        if (d.data.length > 0) setAccountId((cur) => cur || d.data[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!accountId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const d = await api<{ data: RecData }>(
        `/api/bank-accounts/${accountId}/reconciliation?onlyUncleared=${showCleared ? "0" : "1"}`
      );
      setData(d.data);
      setSelected(new Set());
    } catch (err) {
      setData(null);
      setLoadError(err instanceof Error ? err.message : t("fix4.recon.errLoad"));
    } finally {
      setLoading(false);
    }
  }, [accountId, showCleared, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);

  // Module 3: imported statements for the statement-reconciliation split view.
  useEffect(() => {
    if (!accountId) return;
    api<{ data: Statement[] }>(`/api/bank-accounts/${accountId}/statements`)
      .then((d) => {
        setStatements(d.data);
        setStatementId((cur) => (d.data.some((s) => s.id === cur) ? cur : ""));
      })
      .catch(() => setStatements([]));
  }, [accountId]);

  function toggle(id: string) {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function run(action: "clear" | "unclear") {
    if (selected.size === 0 || busy) return;
    if (action === "clear" && !clearedAt) return;
    setBusy(true);
    try {
      await api(`/api/bank-accounts/${accountId}/reconciliation`, {
        method: "POST",
        body: JSON.stringify({
          action,
          lineIds: [...selected],
          ...(action === "clear" ? { clearedAt } : {}),
        }),
      });
      await load();
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : t("fix4.recon.errSave"));
    } finally {
      setBusy(false);
    }
  }

  const uncleared = data?.lines.filter((l) => l.clearedAt == null) ?? [];
  const diffZero = data ? BigInt(data.difference) === 0n : false;

  function toggleAll() {
    setSelected((s) => {
      if (s.size === uncleared.length) return new Set<string>();
      return new Set(uncleared.map((l) => l.lineId));
    });
  }

  return (
    <div>
      <PageHeader
        title={t("fix4.recon.title")}
        subtitle={t("fix4.recon.subtitle")}
        icon={<Landmark size={20} />}
      />

      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label={t("fix4.recon.account")}>
          <select className="field min-w-48" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            {banks.map((b) => (
              <option key={b.id} value={b.id}>{b.name} ({b.kind})</option>
            ))}
          </select>
        </Field>
        {/* Module 3: statement split view */}
        <Field label={m("statementsLink")}>
          <select className="field min-w-48" value={statementId} onChange={(e) => setStatementId(e.target.value)}>
            <option value="">—</option>
            {statements.map((s) => (
              <option key={s.id} value={s.id}>{s.fileName} ({m("lineCount", { count: s.lineCount })})</option>
            ))}
          </select>
        </Field>
        <Link href="/payments/statements" className="btn btn-ghost mb-0.5 text-sm">
          <FileSpreadsheet size={15} /> {m("importStatement")}
        </Link>
        <label className="mb-2 inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={showCleared}
            onChange={(e) => setShowCleared(e.target.checked)}
          />
          {t("fix4.recon.showCleared")}
        </label>
      </div>

      {statementId && (
        <div className="mb-6">
          <StatementDetail
            bankId={accountId}
            statementId={statementId}
            canPost={canPost}
            onDeleted={() => {
              setStatements((ss) => ss.filter((s) => s.id !== statementId));
              setStatementId("");
              load();
            }}
          />
        </div>
      )}

      {loadError ? (
        <div className="card flex flex-wrap items-center gap-3 border-danger/40 bg-danger-soft p-4">
          <TriangleAlert size={20} className="shrink-0 text-danger" />
          <p className="min-w-0 flex-1 text-sm font-semibold text-danger">{loadError}</p>
          <button className="btn btn-danger text-sm" onClick={load}>
            <RotateCcw size={15} /> {t("fix4.recon.tryAgain")}
          </button>
        </div>
      ) : data ? (
        <>
          <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="card p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("fix4.recon.bookBalance")}</p>
              <p className="mt-1 text-xl font-extrabold">{fmtMoney(data.bookBalance)}</p>
            </div>
            <div className="card p-4">
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("fix4.recon.clearedBalance")}</p>
              <p className="mt-1 text-xl font-extrabold">{fmtMoney(data.clearedBalance)}</p>
            </div>
            <div className={`card p-4 ${diffZero ? "border-success/50 bg-success-soft" : "border-warning/50 bg-warning-soft"}`}>
              <p className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{t("fix4.recon.difference")}</p>
              <p className="mt-1 text-xl font-extrabold">{fmtMoney(data.difference)}</p>
              <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                {diffZero ? t("fix4.recon.reconciled") : t("fix4.recon.pending", { count: data.totalCount - data.clearedCount })}
              </p>
            </div>
          </div>

          {uncleared.length > 0 && (
            <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
              <Field label={t("fix4.recon.clearedDate")}>
                <input type="date" className="field" value={clearedAt} onChange={(e) => setClearedAt(e.target.value)} />
              </Field>
              <button className="btn btn-primary text-sm" disabled={busy || selected.size === 0} onClick={() => run("clear")}>
                <CheckCheck size={15} /> {busy ? t("fix4.recon.working") : t("fix4.recon.markCleared", { count: selected.size })}
              </button>
              <button className="btn btn-ghost text-sm" disabled={busy || selected.size === 0} onClick={() => toggleAll()}>
                {t("fix4.recon.selectAll")}
              </button>
            </div>
          )}

          <div className="card overflow-x-auto p-0">
            <table className="tbl min-w-[760px]">
              <thead>
                <tr>
                  <th className="w-10"><span className="sr-only">{t("fix4.recon.select")}</span></th>
                  <th>{t("fix4.recon.colDate")}</th>
                  <th>{t("fix4.recon.colDetails")}</th>
                  <th>{t("fix4.recon.colRef")}</th>
                  <th className="num">{t("fix4.recon.colDebit")}</th>
                  <th className="num">{t("fix4.recon.colCredit")}</th>
                  <th>{t("fix4.recon.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => {
                  const cleared = l.clearedAt != null;
                  return (
                    <tr key={l.lineId} className={cleared ? "opacity-60" : ""}>
                      <td>
                        <input
                          type="checkbox"
                          className="h-4 w-4 accent-primary"
                          checked={selected.has(l.lineId)}
                          onChange={() => toggle(l.lineId)}
                          aria-label={t("fix4.recon.select")}
                        />
                      </td>
                      <td className="whitespace-nowrap">{fmtDate(l.date)}</td>
                      <td className="min-w-48">
                        <div className="font-semibold">{l.memo}</div>
                        {l.partyName && <div className="text-xs text-muted-foreground">{l.partyName}</div>}
                      </td>
                      <td className="whitespace-nowrap text-muted-foreground">{l.reference ?? l.source}</td>
                      <td className="num">{BigInt(l.debit) !== 0n ? fmtMoney(l.debit) : "—"}</td>
                      <td className="num">{BigInt(l.credit) !== 0n ? fmtMoney(l.credit) : "—"}</td>
                      <td className="whitespace-nowrap text-xs">
                        {cleared ? (
                          <span className="font-bold text-success">{t("fix4.recon.clearedOn", { date: fmtDate(l.clearedAt!) })}</span>
                        ) : l.suggestedClearedAt != null ? (
                          <span className="font-semibold text-warning">
                            {t("fix4.recon.pdcSuggest", { date: fmtDate(l.suggestedClearedAt) })}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">{t("fix4.recon.uncleared")}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {data.lines.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                      {t("fix4.recon.allClear")}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {showCleared && selected.size > 0 && (
            <div className="mt-4 flex justify-end">
              <button className="btn btn-ghost text-sm" disabled={busy} onClick={() => run("unclear")}>
                <Undo2 size={15} /> {busy ? t("fix4.recon.working") : t("fix4.recon.markUncleared", { count: selected.size })}
              </button>
            </div>
          )}
          {loading && <p className="mt-3 text-sm text-muted-foreground">{t("fix4.recon.loading")}</p>}
        </>
      ) : null}
    </div>
  );
}
