"use client";

// Payroll run detail: pre-run audit sheet (editable payable days while DRAFT),
// Approve & Post, Void, Disburse, bank advice CSV, payslip links.
import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Briefcase, Download, Printer, Landmark } from "lucide-react";
import { PageHeader, Field, ErrorNote, StatusPill, SummaryChips } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Slip = {
  id: string; employeeCode: string; employeeName: string;
  payableDays: number; workDays: number;
  grossPaisa: string; taxPaisa: string;
  eobiEmployeePaisa: string; eobiEmployerPaisa: string;
  pfEmployeePaisa: string; pfEmployerPaisa: string;
  advancePaisa: string; netPaisa: string;
};

type Run = {
  id: string; year: number; month: number; status: string; docNo: string | null;
  grossPaisa: string; taxPaisa: string;
  eobiEmployeePaisa: string; eobiEmployerPaisa: string;
  pfEmployeePaisa: string; pfEmployerPaisa: string;
  advancePaisa: string; netPaisa: string;
};

type Bank = { id: string; name: string };

export default function RunDetailPage() {
  const { t } = useLang();
  const can = useCan("payroll");
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [slips, setSlips] = useState<Slip[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [days, setDays] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [disburseOpen, setDisburseOpen] = useState(false);
  const [bankId, setBankId] = useState("");
  const [disbDate, setDisbDate] = useState(fmtDateInput(new Date()));

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: { run: Run; slips: Slip[] } }>(`/api/payroll/runs/${id}`);
      setRun(d.data.run); setSlips(d.data.slips);
      const init: Record<string, number> = {};
      for (const s of d.data.slips) init[s.id] = s.payableDays;
      setDays(init);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);
  useEffect(() => {
    api<{ data: Bank[] }>("/api/bank-accounts").then((d) => { setBanks(d.data); setBankId(d.data[0]?.id ?? ""); }).catch(() => {});
  }, []);

  if (!can) return <PageHeader title={t("payroll.title")} icon={<Briefcase size={20} />} />;

  const saveDays = async () => {
    setBusy(true);
    try {
      await api(`/api/payroll/runs/${id}/slips`, {
        method: "PATCH",
        body: JSON.stringify({ items: Object.entries(days).map(([slipId, payableDays]) => ({ slipId, payableDays })) }),
      });
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const act = async (path: string, confirmMsg: string | null, body?: object) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(true);
    try {
      await api(`/api/payroll/runs/${id}${path}`, body ? { method: "POST", body: JSON.stringify({ ...body, idempotencyKey: crypto.randomUUID() }) } : { method: "POST" });
      setDisburseOpen(false);
      load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (!run) return <div className="p-4"><ErrorNote message={error} /></div>;
  const isDraft = run.status === "DRAFT";
  const period = `${run.year}-${String(run.month).padStart(2, "0")}`;

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${t("payroll.title")} ${period}`}
        subtitle={run.docNo ?? ""}
        icon={<Briefcase size={20} />}
        actions={
          <div className="flex flex-wrap gap-2">
            {isDraft && <button className="btn btn-primary !py-2 text-sm" disabled={busy} onClick={() => act("/post", t("payroll.confirmPost"))}>{t("payroll.approvePost")}</button>}
            {run.status === "POSTED" && (
              <>
                <a className="btn btn-ghost !py-2 text-sm" href={`/api/payroll/runs/${id}/advice`}><Download size={15} />{t("payroll.bankAdvice")}</a>
                <button className="btn btn-primary !py-2 text-sm" disabled={busy} onClick={() => setDisburseOpen(true)}><Landmark size={15} />{t("payroll.disburse")}</button>
                <button className="btn btn-ghost !py-2 text-sm !text-danger" disabled={busy} onClick={() => act("/void", t("payroll.confirmVoid"))}>{t("payroll.voidRun")}</button>
              </>
            )}
            {run.status === "PAID" && (
              <a className="btn btn-ghost !py-2 text-sm" href={`/api/payroll/runs/${id}/advice`}><Download size={15} />{t("payroll.bankAdvice")}</a>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />
      <StatusPill status={run.status} />

      <SummaryChips items={[
        { label: t("payroll.gross"), value: fmtMoney(run.grossPaisa) },
        { label: t("payroll.tax"), value: fmtMoney(run.taxPaisa), tone: "danger" },
        { label: `${t("payroll.eobi")} + ${t("payroll.pf")}`, value: fmtMoney(BigInt(run.eobiEmployeePaisa) + BigInt(run.eobiEmployerPaisa) + BigInt(run.pfEmployeePaisa) + BigInt(run.pfEmployerPaisa)) },
        { label: t("payroll.advanceDeducted"), value: fmtMoney(run.advancePaisa), tone: "accent" },
        { label: t("payroll.totalNet"), value: fmtMoney(run.netPaisa), tone: "primary" },
      ]} />

      <div className="rounded-2xl border border-border bg-card">
        <div className="border-b border-border px-4 py-3">
          <div className="text-sm font-bold">{t("payroll.auditSheet")}</div>
          {isDraft && <p className="mt-1 text-xs text-muted-foreground">{t("payroll.editDaysHint")}</p>}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-border text-start text-xs text-muted-foreground">
                <th className="px-3 py-2 text-start font-semibold">{t("payroll.code")}</th>
                <th className="px-3 py-2 text-start font-semibold">{t("payroll.fullName")}</th>
                <th className="px-3 py-2 text-center font-semibold">{t("payroll.payableDays")}</th>
                <th className="px-3 py-2 text-end font-semibold">{t("payroll.gross")}</th>
                <th className="px-3 py-2 text-end font-semibold">{t("payroll.tax")}</th>
                <th className="px-3 py-2 text-end font-semibold">{t("payroll.eobi")}/{t("payroll.pf")}</th>
                <th className="px-3 py-2 text-end font-semibold">{t("payroll.advance")}</th>
                <th className="px-3 py-2 text-end font-semibold">{t("payroll.net")}</th>
                <th className="px-3 py-2 text-center font-semibold">{t("payroll.payslip")}</th>
              </tr>
            </thead>
            <tbody>
              {slips.map((s) => (
                <tr key={s.id} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 font-mono text-xs">{s.employeeCode}</td>
                  <td className="px-3 py-2">{s.employeeName}</td>
                  <td className="px-3 py-2 text-center">
                    {isDraft ? (
                      <input type="number" min={0} max={s.workDays} className="input mx-auto w-16 !py-1 text-center"
                        value={days[s.id] ?? s.payableDays}
                        onChange={(e) => setDays({ ...days, [s.id]: Math.max(0, Number(e.target.value)) })} />
                    ) : (
                      <span>{s.payableDays}/{s.workDays}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-end">{fmtMoney(s.grossPaisa)}</td>
                  <td className="px-3 py-2 text-end">{fmtMoney(s.taxPaisa)}</td>
                  <td className="px-3 py-2 text-end">{fmtMoney(BigInt(s.eobiEmployeePaisa) + BigInt(s.pfEmployeePaisa))}</td>
                  <td className="px-3 py-2 text-end">{fmtMoney(s.advancePaisa)}</td>
                  <td className="px-3 py-2 text-end font-bold">{fmtMoney(s.netPaisa)}</td>
                  <td className="px-3 py-2 text-center">
                    <Link href={`/payroll/slips/${s.id}`} className="btn btn-ghost !p-1.5"><Printer size={14} /></Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {isDraft && (
          <div className="flex justify-end border-t border-border p-3">
            <button className="btn btn-primary !py-2 text-sm" onClick={saveDays} disabled={busy}>{t("payroll.save")}</button>
          </div>
        )}
      </div>

      {disburseOpen && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setDisburseOpen(false)}>
          <div className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold">{t("payroll.disburse")} — {fmtMoney(run.netPaisa)}</h2>
            <div className="mt-4 space-y-3">
              <Field label={t("payroll.bankAccount")} required>
                <select className="input" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label={t("payroll.date")} required>
                <input type="date" className="input" value={disbDate} onChange={(e) => setDisbDate(e.target.value)} />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setDisburseOpen(false)}>{t("payroll.cancel")}</button>
              <button className="btn btn-primary" disabled={busy || !bankId}
                onClick={() => act("/disburse", t("payroll.confirmDisburse"), { bankAccountId: bankId, date: disbDate })}>
                {t("payroll.disburse")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
