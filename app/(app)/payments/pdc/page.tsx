"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Plus, CalendarDays, Landmark, CheckCircle2, XCircle, Ban } from "lucide-react";
import { PageHeader, EmptyState, FilterBar, SummaryChips, Pagination, ErrorNote, Field } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtDate, fmtDateInput, toBig } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";

type Pdc = {
  id: string; kind: string; partyId: string; chequeNo: string; bankName: string | null;
  amount: string; chequeDate: string; refNo: string | null; status: string;
  notes: string | null; partyName: string | null;
};
type Bank = { id: string; name: string; kind: string };

const PER_PAGE = 20;
const STATUSES = ["", "PENDING", "CLEARED", "BOUNCED", "CANCELLED"] as const;

const statusBadge: Record<string, string> = {
  PENDING: "bg-accent-soft text-accent",
  CLEARED: "bg-primary-soft text-primary",
  BOUNCED: "bg-danger-soft text-danger",
  CANCELLED: "bg-muted text-muted-foreground",
};

type ActionTarget = { pdc: Pdc; action: "clear" | "bounce" | "cancel" } | null;

export default function PdcRegisterPage() {
  const { t } = useLang();
  const canPay = useCan("payments");
  const [kind, setKind] = useState<"RECEIVED" | "ISSUED">("RECEIVED");
  const [status, setStatus] = useState<(typeof STATUSES)[number]>("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Pdc[]>([]);
  const [total, setTotal] = useState(0);
  const [pendingR, setPendingR] = useState("0");
  const [pendingI, setPendingI] = useState("0");
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<ActionTarget>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ kind, page: String(page), perPage: String(PER_PAGE) });
      if (status) params.set("status", status);
      if (from) params.set("from", from);
      if (to) params.set("to", to);
      const d = await api<{
        data: Pdc[]; total: number; pendingReceived: string | number; pendingIssued: string | number;
      }>(`/api/pdc?${params.toString()}`);
      setRows(d.data);
      setTotal(d.total);
      setPendingR(String(d.pendingReceived ?? "0"));
      setPendingI(String(d.pendingIssued ?? "0"));
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind, status, from, to, page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on filter/mount change
  useEffect(() => { load(); }, [load]);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reset to first page when filters change
  useEffect(() => { setPage(1); }, [kind, status, from, to]);

  const hasFilter = status !== "" || from !== "" || to !== "";

  return (
    <div>
      <PageHeader
        title={t("pdc.title")}
        subtitle={t("pdc.subtitle")}
        icon={<Landmark size={20} />}
        actions={canPay ? (
          <Link href="/payments/pdc/new" className="btn btn-primary text-sm">
            <Plus size={16} /> {t("pdc.recordPdc")}
          </Link>
        ) : undefined}
      />

      <FilterBar>
        <div className="flex gap-1 rounded-xl bg-muted p-1">
          {([["RECEIVED", t("pdc.tabReceived")], ["ISSUED", t("pdc.tabIssued")]] as const).map(([v, l]) => (
            <button key={v} onClick={() => setKind(v)}
              className={`rounded-lg px-4 py-1.5 text-xs font-bold transition ${kind === v ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
              {l}
            </button>
          ))}
        </div>
        <select className="field !w-auto !py-2 text-xs" value={status} onChange={(e) => setStatus(e.target.value as (typeof STATUSES)[number])} aria-label={t("pdc.colStatus")}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>{s === "" ? t("pdc.allStatuses") : t(`pdc.status${s.charAt(0) + s.slice(1).toLowerCase()}`)}</option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <CalendarDays size={15} className="shrink-0 text-muted-foreground" />
          <input type="date" className="field !w-auto !py-2 text-xs" value={from} onChange={(e) => setFrom(e.target.value)} aria-label={t("pdc.fromDate")} />
          <span className="text-xs text-muted-foreground">{t("pdc.toWord")}</span>
          <input type="date" className="field !w-auto !py-2 text-xs" value={to} onChange={(e) => setTo(e.target.value)} aria-label={t("pdc.toDate")} />
        </div>
        {hasFilter && (
          <button className="text-xs font-bold text-danger hover:underline"
            onClick={() => { setStatus(""); setFrom(""); setTo(""); }}>
            {t("pdc.clearFilters")}
          </button>
        )}
      </FilterBar>

      {!loading && (
        <SummaryChips items={[
          { label: t("pdc.sumPendingReceived"), value: fmtMoney(toBig(pendingR)), tone: "primary" },
          { label: t("pdc.sumPendingIssued"), value: fmtMoney(toBig(pendingI)), tone: "danger" },
          { label: t("pdc.sumNetPending"), value: fmtMoney(toBig(pendingR) - toBig(pendingI)), tone: "neutral" },
        ]} />
      )}

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={t("pdc.emptyTitle")}
            hint={hasFilter ? t("pdc.emptyHintFilter") : t("pdc.emptyHint")}
            action={!hasFilter && canPay ? <Link href="/payments/pdc/new" className="btn btn-primary text-sm"><Plus size={16} /> {t("pdc.recordNow")}</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{t("pdc.colChequeNo")}</th><th>{t("pdc.colChequeDate")}</th><th>{t("pdc.colParty")}</th>
                <th>{t("pdc.colBank")}</th><th className="num">{t("pdc.colAmount")}</th>
                <th>{t("pdc.colStatus")}</th><th className="text-right">{t("pdc.colActions")}</th>
              </tr></thead>
              <tbody>
                {rows.map((p) => (
                  <tr key={p.id}>
                    <td className="font-bold whitespace-nowrap">{p.chequeNo}{p.refNo ? <span className="ml-1.5 text-xs font-normal text-muted-foreground">· {p.refNo}</span> : null}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.chequeDate)}</td>
                    <td className="max-w-44 truncate font-semibold">{p.partyName ?? "—"}</td>
                    <td className="text-muted-foreground">{p.bankName ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(p.amount)}</td>
                    <td><span className={`badge ${statusBadge[p.status] ?? "bg-muted text-muted-foreground"}`}>{t(`pdc.status${p.status.charAt(0) + p.status.slice(1).toLowerCase()}`)}</span></td>
                    <td className="text-right">
                      {p.status === "PENDING" && canPay ? (
                        <div className="flex justify-end gap-1.5">
                          <button className="btn btn-ghost !px-2.5 !py-1.5 text-xs" title={t("pdc.actClear")}
                            onClick={() => setTarget({ pdc: p, action: "clear" })}>
                            <CheckCircle2 size={14} /> <span className="hidden sm:inline">{t("pdc.actClear")}</span>
                          </button>
                          <button className="btn btn-ghost !px-2.5 !py-1.5 text-xs text-accent" title={t("pdc.actBounce")}
                            onClick={() => setTarget({ pdc: p, action: "bounce" })}>
                            <XCircle size={14} /> <span className="hidden sm:inline">{t("pdc.actBounce")}</span>
                          </button>
                          <button className="btn btn-ghost !px-2.5 !py-1.5 text-xs text-danger" title={t("pdc.actCancel")}
                            onClick={() => setTarget({ pdc: p, action: "cancel" })}>
                            <Ban size={14} /> <span className="hidden sm:inline">{t("pdc.actCancel")}</span>
                          </button>
                        </div>
                      ) : <span className="text-xs text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />

      {target && (
        <PdcActionDialog
          target={target}
          onClose={() => setTarget(null)}
          onDone={() => { setTarget(null); load(); }}
        />
      )}
    </div>
  );
}

function PdcActionDialog({ target, onClose, onDone }: {
  target: NonNullable<ActionTarget>; onClose: () => void; onDone: () => void;
}) {
  const { t } = useLang();
  const { pdc, action } = target;
  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [date, setDate] = useState(fmtDateInput());
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (action !== "clear") return;
    api<{ data: Bank[] }>("/api/banks").then((d) => {
      const list = d.data.filter((b) => b.kind !== "CASH");
      setBanks(list);
      if (list.length > 0) setBankId(list[0].id);
    }).catch(() => {});
  }, [action]);

  const title = action === "clear" ? t("pdc.clearTitle") : action === "bounce" ? t("pdc.bounceTitle") : t("pdc.cancelTitle");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (action === "clear" && !bankId) { setError(t("pdc.errBank")); return; }
    if (!date) { setError(t("pdc.errDate")); return; }
    setSaving(true);
    try {
      const body = action === "clear"
        ? { bankAccountId: bankId, date }
        : { date, reason: reason || undefined };
      await api(`/api/pdc/${pdc.id}/${action}`, { method: "POST", body: JSON.stringify(body) });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pdc.errSave"));
      setSaving(false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        <ErrorNote message={error} />
        <div className="rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <p className="font-bold">{pdc.chequeNo} · {fmtMoney(pdc.amount)}</p>
          <p className="text-xs text-muted-foreground">{pdc.partyName ?? ""} · {fmtDate(pdc.chequeDate)}</p>
        </div>
        {action === "clear" && (
          <Field label={t("pdc.clearBank")}>
            <select className="field" value={bankId} onChange={(e) => setBankId(e.target.value)} required>
              <option value="">{t("pdc.selectBank")}</option>
              {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
        )}
        <Field label={t("pdc.actionDate")}>
          <input type="date" className="field" required value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        {action !== "clear" && (
          <Field label={t("pdc.reasonLabel")}>
            <input className="field" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder={t("pdc.reasonPlaceholder")} maxLength={200} />
          </Field>
        )}
        <div className="flex gap-2 pt-1">
          <button type="button" className="btn btn-ghost flex-1" onClick={onClose}>{t("common.cancel")}</button>
          <button type="submit" disabled={saving}
            className={`btn flex-1 ${action === "clear" ? "btn-primary" : "btn-danger"}`}>
            {saving ? t("pdc.working") : title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
