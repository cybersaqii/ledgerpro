"use client";

// Employees master + advances, with add/edit modals.
import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import { Users, Plus, Search, Pencil, HandCoins } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney, fmtDate, fmtDateInput } from "@/lib/format";

type Employee = {
  id: string; code: string; fullName: string; cnic: string | null; email: string | null;
  department: string | null; designation: string | null; joiningDate: number;
  employmentType: string; bankName: string | null; bankAccountNo: string | null; ntn: string | null;
  baseSalaryPaisa: string; basicPaisa: string; hraPaisa: string; medicalPaisa: string;
  conveyancePaisa: string; specialAllowancePaisa: string; isActive: boolean;
};

type Advance = {
  id: string; employeeId: string; employeeName: string | null; employeeCode: string | null;
  date: number; amountPaisa: string; balancePaisa: string; status: string; note: string | null;
};

type Bank = { id: string; name: string };

const blankEmp = {
  code: "", fullName: "", cnic: "", email: "", department: "", designation: "",
  joiningDate: fmtDateInput(new Date()), employmentType: "PERMANENT",
  bankName: "", bankAccountNo: "", ntn: "",
  baseSalary: "", basic: "", hra: "", medical: "", conveyance: "", specialAllowance: "",
};

export default function EmployeesPage() {
  const { t } = useLang();
  const can = useCan("payroll");
  const sp = useSearchParams();
  const [tab, setTab] = useState<"employees" | "advances">(sp.get("tab") === "advances" ? "advances" : "employees");
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [advances, setAdvances] = useState<Advance[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [empForm, setEmpForm] = useState<typeof blankEmp | null>(null);
  const [editing, setEditing] = useState<Employee | null>(null);
  const [advForm, setAdvForm] = useState<{ employeeId: string; amount: string; date: string; bankAccountId: string; note: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, a, b] = await Promise.all([
        api<{ data: Employee[] }>(`/api/payroll/employees?q=${encodeURIComponent(q)}`),
        api<{ data: Advance[] }>("/api/payroll/advances"),
        api<{ data: Bank[] }>("/api/bank-accounts"),
      ]);
      setEmployees(e.data); setAdvances(a.data); setBanks(b.data); setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [q]);
  useEffect(() => { const h = setTimeout(load, 250); return () => clearTimeout(h); }, [load]);

  if (!can) return <PageHeader title={t("payroll.employees")} icon={<Users size={20} />} />;

  const saveEmployee = async () => {
    if (!empForm) return;
    setBusy(true);
    try {
      if (editing) {
        await api(`/api/payroll/employees/${editing.id}`, {
          method: "PATCH",
          body: JSON.stringify({
            fullName: empForm.fullName, cnic: empForm.cnic || null, email: empForm.email || null,
            department: empForm.department || null, designation: empForm.designation || null,
            employmentType: empForm.employmentType, bankName: empForm.bankName || null,
            bankAccountNo: empForm.bankAccountNo || null, ntn: empForm.ntn || null,
            baseSalary: empForm.baseSalary || "0", basic: empForm.basic || "0",
            hra: empForm.hra || "0", medical: empForm.medical || "0",
            conveyance: empForm.conveyance || "0", specialAllowance: empForm.specialAllowance || "0",
          }),
        });
      } else {
        await api("/api/payroll/employees", {
          method: "POST",
          body: JSON.stringify({ ...empForm, idempotencyKey: crypto.randomUUID() }),
        });
      }
      setEmpForm(null); setEditing(null); load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const toggleActive = async (e: Employee) => {
    try {
      await api(`/api/payroll/employees/${e.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !e.isActive }),
      });
      load();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const openEdit = (e: Employee) => {
    setEditing(e);
    setEmpForm({
      code: e.code, fullName: e.fullName, cnic: e.cnic ?? "", email: e.email ?? "",
      department: e.department ?? "", designation: e.designation ?? "",
      joiningDate: fmtDateInput(new Date(e.joiningDate)), employmentType: e.employmentType,
      bankName: e.bankName ?? "", bankAccountNo: e.bankAccountNo ?? "", ntn: e.ntn ?? "",
      baseSalary: (BigInt(e.baseSalaryPaisa) / 100n).toString(),
      basic: (BigInt(e.basicPaisa) / 100n).toString(),
      hra: (BigInt(e.hraPaisa) / 100n).toString(),
      medical: (BigInt(e.medicalPaisa) / 100n).toString(),
      conveyance: (BigInt(e.conveyancePaisa) / 100n).toString(),
      specialAllowance: (BigInt(e.specialAllowancePaisa) / 100n).toString(),
    });
  };

  const issueAdvance = async () => {
    if (!advForm) return;
    setBusy(true);
    try {
      await api("/api/payroll/advances", {
        method: "POST",
        body: JSON.stringify({ ...advForm, idempotencyKey: crypto.randomUUID() }),
      });
      setAdvForm(null); setTab("advances"); load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const empTypeLabel = (x: string) =>
    x === "PERMANENT" ? t("payroll.permanent") : x === "CONTRACT" ? t("payroll.contract") : t("payroll.dailyWage");

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("payroll.employees")}
        icon={<Users size={20} />}
        actions={
          <div className="flex gap-2">
            <button className="btn btn-ghost !py-2 text-sm" onClick={() => setAdvForm({ employeeId: employees[0]?.id ?? "", amount: "", date: fmtDateInput(new Date()), bankAccountId: banks[0]?.id ?? "", note: "" })}>
              <HandCoins size={15} />{t("payroll.newAdvance")}
            </button>
            <button className="btn btn-primary !py-2 text-sm" onClick={() => { setEditing(null); setEmpForm({ ...blankEmp }); }}>
              <Plus size={15} />{t("payroll.newEmployee")}
            </button>
          </div>
        }
      />
      <ErrorNote message={error} />

      <div className="flex gap-2">
        {(["employees", "advances"] as const).map((x) => (
          <button key={x} onClick={() => setTab(x)}
            className={`rounded-full px-4 py-1.5 text-sm font-semibold ${tab === x ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
            {x === "employees" ? t("payroll.employees") : t("payroll.advances")}
          </button>
        ))}
      </div>

      {tab === "employees" && (
        <>
          <div className="relative">
            <Search size={15} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input className="input ps-9" placeholder={t("payroll.searchEmployees")} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <div className="rounded-2xl border border-border bg-card">
            {employees.length === 0 ? (
              <div className="p-4"><EmptyState title={t("payroll.noEmployees")} icon={<Users size={22} />} /></div>
            ) : (
              <ul className="divide-y divide-border">
                {employees.map((e) => (
                  <li key={e.id} className="flex items-center gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-bold">{e.fullName}</span>
                        {!e.isActive && <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t("payroll.inactive")}</span>}
                      </div>
                      <div className="mt-0.5 text-xs text-muted-foreground">
                        {e.code} · {empTypeLabel(e.employmentType)} · {fmtMoney(e.baseSalaryPaisa)}
                      </div>
                    </div>
                    <button className="btn btn-ghost !p-2" onClick={() => openEdit(e)} title={t("payroll.save")}><Pencil size={15} /></button>
                    <button className="btn btn-ghost !p-2 !text-xs" onClick={() => toggleActive(e)}>
                      {e.isActive ? t("payroll.deactivate") : t("payroll.reactivate")}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}

      {tab === "advances" && (
        <div className="rounded-2xl border border-border bg-card">
          {advances.length === 0 ? (
            <div className="p-4"><EmptyState title={t("payroll.noAdvances")} icon={<HandCoins size={22} />} /></div>
          ) : (
            <ul className="divide-y divide-border">
              {advances.map((a) => (
                <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-bold">{a.employeeName} <span className="font-normal text-muted-foreground">({a.employeeCode})</span></div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {fmtDate(a.date)} · {a.status}{a.note ? ` · ${a.note}` : ""}
                    </div>
                  </div>
                  <div className="text-end">
                    <div className="text-sm font-bold">{fmtMoney(a.amountPaisa)}</div>
                    <div className="text-xs text-muted-foreground">{t("payroll.openBalance")}: {fmtMoney(a.balancePaisa)}</div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {empForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setEmpForm(null)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold">{editing ? editing.fullName : t("payroll.newEmployee")}</h2>
            <div className="mt-4 grid grid-cols-2 gap-3">
              {!editing && <Field label={t("payroll.code")} required><input className="input" value={empForm.code} onChange={(e) => setEmpForm({ ...empForm, code: e.target.value })} /></Field>}
              <Field label={t("payroll.fullName")} required><input className="input" value={empForm.fullName} onChange={(e) => setEmpForm({ ...empForm, fullName: e.target.value })} /></Field>
              <Field label={t("payroll.cnic")}><input className="input" value={empForm.cnic} onChange={(e) => setEmpForm({ ...empForm, cnic: e.target.value })} /></Field>
              <Field label={t("payroll.email")}><input className="input" value={empForm.email} onChange={(e) => setEmpForm({ ...empForm, email: e.target.value })} /></Field>
              <Field label={t("payroll.department")}><input className="input" value={empForm.department} onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })} /></Field>
              <Field label={t("payroll.designation")}><input className="input" value={empForm.designation} onChange={(e) => setEmpForm({ ...empForm, designation: e.target.value })} /></Field>
              {!editing && <Field label={t("payroll.joiningDate")} required><input type="date" className="input" value={empForm.joiningDate} onChange={(e) => setEmpForm({ ...empForm, joiningDate: e.target.value })} /></Field>}
              <Field label={t("payroll.employmentType")}>
                <select className="input" value={empForm.employmentType} onChange={(e) => setEmpForm({ ...empForm, employmentType: e.target.value })}>
                  <option value="PERMANENT">{t("payroll.permanent")}</option>
                  <option value="CONTRACT">{t("payroll.contract")}</option>
                  <option value="DAILY_WAGE">{t("payroll.dailyWage")}</option>
                </select>
              </Field>
              <Field label={t("payroll.bankName")}><input className="input" value={empForm.bankName} onChange={(e) => setEmpForm({ ...empForm, bankName: e.target.value })} /></Field>
              <Field label={t("payroll.bankAccountNo")}><input className="input" value={empForm.bankAccountNo} onChange={(e) => setEmpForm({ ...empForm, bankAccountNo: e.target.value })} /></Field>
              <Field label={t("payroll.ntn")}><input className="input" value={empForm.ntn} onChange={(e) => setEmpForm({ ...empForm, ntn: e.target.value })} /></Field>
              <Field label={empForm.employmentType === "DAILY_WAGE" ? t("payroll.dailyRate") : t("payroll.monthlySalary")} required>
                <input type="number" min="0" className="input" value={empForm.baseSalary} onChange={(e) => setEmpForm({ ...empForm, baseSalary: e.target.value })} />
              </Field>
            </div>
            {empForm.employmentType !== "DAILY_WAGE" && (
              <div className="mt-4 rounded-xl bg-muted/40 p-3">
                <div className="text-xs font-bold text-muted-foreground">{t("payroll.salaryStructure")}</div>
                <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-3">
                  {([["basic", t("payroll.basic")], ["hra", t("payroll.hra")], ["medical", t("payroll.medical")], ["conveyance", t("payroll.conveyance")], ["specialAllowance", t("payroll.special")]] as const).map(([k, label]) => (
                    <Field key={k} label={label}>
                      <input type="number" min="0" className="input" value={empForm[k]} onChange={(e) => setEmpForm({ ...empForm, [k]: e.target.value })} />
                    </Field>
                  ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{t("payroll.salaryHint")}</p>
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setEmpForm(null)}>{t("payroll.cancel")}</button>
              <button className="btn btn-primary" onClick={saveEmployee} disabled={busy}>{t("payroll.save")}</button>
            </div>
          </div>
        </div>
      )}

      {advForm && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center" onClick={() => setAdvForm(null)}>
          <div className="w-full max-w-md rounded-t-2xl bg-card p-5 sm:rounded-2xl" onClick={(e) => e.stopPropagation()}>
            <h2 className="text-base font-bold">{t("payroll.newAdvance")}</h2>
            <div className="mt-4 space-y-3">
              <Field label={t("payroll.employees")} required>
                <select className="input" value={advForm.employeeId} onChange={(e) => setAdvForm({ ...advForm, employeeId: e.target.value })}>
                  {employees.filter((e) => e.isActive).map((e) => <option key={e.id} value={e.id}>{e.fullName} ({e.code})</option>)}
                </select>
              </Field>
              <Field label={t("payroll.amount")} required>
                <input type="number" min="0" className="input" value={advForm.amount} onChange={(e) => setAdvForm({ ...advForm, amount: e.target.value })} />
              </Field>
              <Field label={t("payroll.date")} required>
                <input type="date" className="input" value={advForm.date} onChange={(e) => setAdvForm({ ...advForm, date: e.target.value })} />
              </Field>
              <Field label={t("payroll.bankAccount")} required>
                <select className="input" value={advForm.bankAccountId} onChange={(e) => setAdvForm({ ...advForm, bankAccountId: e.target.value })}>
                  {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </Field>
              <Field label={t("payroll.note")}>
                <input className="input" value={advForm.note} onChange={(e) => setAdvForm({ ...advForm, note: e.target.value })} />
              </Field>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setAdvForm(null)}>{t("payroll.cancel")}</button>
              <button className="btn btn-primary" onClick={issueAdvance} disabled={busy}>{t("payroll.newAdvance")}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
