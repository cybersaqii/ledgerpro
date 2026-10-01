"use client";

// Individual payslip view with print CSS (no PDF library).
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { Printer, Briefcase } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Data = {
  slip: {
    id: string; employeeCode: string; employeeName: string;
    payableDays: number; workDays: number;
    basicPaisa: string; hraPaisa: string; medicalPaisa: string;
    conveyancePaisa: string; specialAllowancePaisa: string;
    grossPaisa: string; taxPaisa: string;
    eobiEmployeePaisa: string; eobiEmployerPaisa: string;
    pfEmployeePaisa: string; pfEmployerPaisa: string;
    advancePaisa: string; netPaisa: string;
  };
  run: { year: number; month: number; docNo: string | null; status: string };
  employee: { designation: string | null; department: string | null; cnic: string | null; bankAccountNo: string | null } | null;
  company: { name: string; tradeName: string | null; address: string | null; city: string | null; phone: string | null } | null;
};

export default function PayslipPage() {
  const { t } = useLang();
  const can = useCan("payroll");
  const { slipId } = useParams<{ slipId: string }>();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Data }>(`/api/payroll/slips/${slipId}`)
      .then((d) => setData(d.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [slipId]);

  if (!can) return <PageHeader title={t("payroll.payslip")} icon={<Briefcase size={20} />} />;
  if (error) return <div className="p-4"><ErrorNote message={error} /></div>;
  if (!data) return <div className="p-4 text-sm text-muted-foreground">…</div>;

  const { slip, run, employee, company } = data;
  const period = `${run.year}-${String(run.month).padStart(2, "0")}`;
  const earnings = [
    [t("payroll.basic"), slip.basicPaisa],
    [t("payroll.hra"), slip.hraPaisa],
    [t("payroll.medical"), slip.medicalPaisa],
    [t("payroll.conveyance"), slip.conveyancePaisa],
    [t("payroll.special"), slip.specialAllowancePaisa],
  ].filter(([, v]) => BigInt(v) > 0n) as [string, string][];
  const deductions = [
    [t("payroll.tax"), slip.taxPaisa],
    [t("payroll.eobi"), slip.eobiEmployeePaisa],
    [t("payroll.pf"), slip.pfEmployeePaisa],
    [t("payroll.advanceDeducted"), slip.advancePaisa],
  ].filter(([, v]) => BigInt(v) > 0n) as [string, string][];

  return (
    <div className="space-y-4">
      <style>{`@media print { body * { visibility: hidden; } #payslip-print, #payslip-print * { visibility: visible; } #payslip-print { position: absolute; inset: 0; margin: 0; } .no-print { display: none !important; } }`}</style>
      <div className="no-print">
        <PageHeader
          title={t("payroll.payslip")}
          icon={<Briefcase size={20} />}
          actions={<button className="btn btn-primary !py-2 text-sm" onClick={() => window.print()}><Printer size={15} />{t("payroll.print")}</button>}
        />
      </div>

      <div id="payslip-print" className="mx-auto max-w-2xl rounded-2xl border border-border bg-white p-6 text-slate-900 dark:bg-card dark:text-card-foreground print:rounded-none print:border-0">
        <div className="text-center">
          <div className="text-lg font-extrabold">{company?.tradeName || company?.name}</div>
          {[company?.address, company?.city, company?.phone].filter(Boolean).join(" · ") && (
            <div className="mt-1 text-xs text-slate-500">{[company?.address, company?.city, company?.phone].filter(Boolean).join(" · ")}</div>
          )}
          <div className="mt-2 inline-block rounded-full bg-slate-100 px-3 py-1 text-xs font-bold dark:bg-muted">
            {t("payroll.payslip")} — {t("payroll.payPeriod")}: {period}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
          <div><span className="text-slate-500">{t("payroll.fullName")}: </span><b>{slip.employeeName}</b></div>
          <div><span className="text-slate-500">{t("payroll.code")}: </span><b className="font-mono">{slip.employeeCode}</b></div>
          {employee?.designation && <div><span className="text-slate-500">{t("payroll.designation")}: </span>{employee.designation}</div>}
          {employee?.department && <div><span className="text-slate-500">{t("payroll.department")}: </span>{employee.department}</div>}
          {employee?.cnic && <div><span className="text-slate-500">{t("payroll.cnic")}: </span>{employee.cnic}</div>}
          <div><span className="text-slate-500">{t("payroll.payableDays")}: </span>{slip.payableDays}/{slip.workDays}</div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <div className="border-b pb-1 text-sm font-bold">{t("payroll.earnings")}</div>
            {earnings.map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 text-sm"><span>{k}</span><span className="font-mono">{fmtMoney(v)}</span></div>
            ))}
            <div className="flex justify-between border-t pt-1 text-sm font-bold"><span>{t("payroll.gross")}</span><span className="font-mono">{fmtMoney(slip.grossPaisa)}</span></div>
          </div>
          <div>
            <div className="border-b pb-1 text-sm font-bold">{t("payroll.deductions")}</div>
            {deductions.map(([k, v]) => (
              <div key={k} className="flex justify-between py-1 text-sm"><span>{k}</span><span className="font-mono">{fmtMoney(v)}</span></div>
            ))}
            {BigInt(slip.eobiEmployerPaisa) + BigInt(slip.pfEmployerPaisa) > 0n && (
              <div className="flex justify-between py-1 text-xs text-slate-500"><span>{t("payroll.employerShare")} ({t("payroll.eobi")}/{t("payroll.pf")})</span><span className="font-mono">{fmtMoney(BigInt(slip.eobiEmployerPaisa) + BigInt(slip.pfEmployerPaisa))}</span></div>
            )}
            <div className="flex justify-between border-t pt-1 text-sm font-bold"><span>{t("payroll.net")}</span><span className="font-mono">{fmtMoney(slip.netPaisa)}</span></div>
          </div>
        </div>

        <div className="mt-6 flex items-end justify-between text-xs text-slate-500">
          <div>{t("payroll.docNo")}: {run.docNo ?? "—"}</div>
          <div className="text-center"><div className="h-10 border-b border-slate-300" /><div className="mt-1">{t("payroll.employees")}</div></div>
        </div>
      </div>
    </div>
  );
}
