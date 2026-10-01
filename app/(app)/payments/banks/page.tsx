"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Landmark, Plus } from "lucide-react";
import { PageHeader, ErrorNote, Switch, Field } from "@/components/ui";
import { Modal } from "@/components/modal";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Bank = {
  id: string; name: string; kind: string; accountType: string;
  bankName: string | null; accountNo: string | null; iban: string | null;
  balance: string; isActive: boolean;
};

const ACCOUNT_TYPES = ["CURRENT", "SAVINGS", "OVERDRAFT", "PETTY_CASH"] as const;

export default function BanksPage() {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");

  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Module 3: new account modal
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({
    name: "", kind: "BANK", accountType: "CURRENT",
    bankName: "", accountNo: "", iban: "", openingBalance: "0",
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ data: Bank[] }>("/api/banks?all=1");
      setBanks(d.data);
    } catch {
      setError(t("banks.errLoad"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount
  useEffect(() => { load(); }, [load]);

  async function toggle(b: Bank) {
    if (busyId) return;
    setBusyId(b.id);
    setError(null);
    try {
      await api(`/api/bank-accounts/${b.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: !b.isActive }),
      });
      setBanks((bs) => bs.map((x) => (x.id === b.id ? { ...x, isActive: !b.isActive } : x)));
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      // The 409 guard speaks English; surface the translated equivalent.
      setError(msg.includes("Cannot deactivate") ? t("banks.deactivateBlocked") : msg || t("banks.errSave"));
    } finally {
      setBusyId(null);
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setFormError(null);
    try {
      await api("/api/banks", { method: "POST", body: JSON.stringify(form) });
      setModal(false);
      setForm({ name: "", kind: "BANK", accountType: "CURRENT", bankName: "", accountNo: "", iban: "", openingBalance: "0" });
      load();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : m("errCreate"));
    } finally {
      setSaving(false);
    }
  }

  function kindLabel(kind: string) {
    if (kind === "CASH") return t("banks.kindCash");
    if (kind === "WALLET") return t("banks.kindWallet");
    return t("banks.kindBank");
  }

  function typeLabel(at: string) {
    if (at === "SAVINGS") return m("typeSavings");
    if (at === "OVERDRAFT") return m("typeOverdraft");
    if (at === "PETTY_CASH") return m("typePettyCash");
    return m("typeCurrent");
  }

  return (
    <div>
      <PageHeader
        title={t("banks.title")}
        subtitle={t("banks.subtitle")}
        icon={<Landmark size={20} />}
        actions={
          <div className="flex gap-2">
            <Link href="/payments" className="btn btn-ghost text-sm">
              <ArrowLeft size={16} className="rtl:rotate-180" /> {t("banks.backToPayments")}
            </Link>
            {canPost && (
              <button className="btn btn-primary text-sm" onClick={() => { setFormError(null); setModal(true); }}>
                <Plus size={16} /> {m("newAccount")}
              </button>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />

      {loading ? (
        <div className="card p-8 text-center text-sm text-muted-foreground">…</div>
      ) : (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead>
                <tr>
                  <th>{t("banks.colAccount")}</th>
                  <th>{t("banks.colType")}</th>
                  <th className="num">{t("banks.colBalance")}</th>
                  <th className="text-end">{t("banks.colStatus")}</th>
                </tr>
              </thead>
              <tbody>
                {banks.map((b) => (
                  <tr key={b.id} className={b.isActive ? "" : "opacity-60"}>
                    <td>
                      <div className="font-bold">{b.name}</div>
                      {([b.bankName, b.accountNo, b.iban].filter(Boolean).length > 0) && (
                        <div className="text-xs text-muted-foreground" dir="ltr">
                          {[b.bankName, b.accountNo, b.iban].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>
                      <div>{kindLabel(b.kind)}</div>
                      {b.kind === "BANK" && (
                        <div className="text-xs text-muted-foreground">{typeLabel(b.accountType)}</div>
                      )}
                    </td>
                    <td className="num font-bold">{fmtMoney(b.balance)}</td>
                    <td>
                      <div className="flex items-center justify-end gap-2">
                        <span className={`text-xs font-bold ${b.isActive ? "text-primary" : "text-muted-foreground"}`}>
                          {b.isActive ? t("banks.active") : t("banks.inactive")}
                        </span>
                        <Switch
                          checked={b.isActive}
                          disabled={busyId === b.id || !canPost}
                          label={b.isActive ? t("banks.active") : t("banks.inactive")}
                          onChange={() => toggle(b)}
                        />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {modal && (
        <Modal onClose={() => setModal(false)} title={m("newAccount")}>
          <form onSubmit={create} className="grid gap-4">
            <ErrorNote message={formError} />
            <Field label={t("banks.colAccount")}>
              <input
                className="field" required minLength={2} maxLength={80}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="e.g. Meezan — Main"
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("banks.colType")}>
                <select className="field" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  <option value="BANK">{t("banks.kindBank")}</option>
                  <option value="CASH">{t("banks.kindCash")}</option>
                  <option value="WALLET">{t("banks.kindWallet")}</option>
                </select>
              </Field>
              {form.kind === "BANK" && (
                <Field label={m("accountType")}>
                  <select className="field" value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })}>
                    {ACCOUNT_TYPES.map((at) => (
                      <option key={at} value={at}>{typeLabel(at)}</option>
                    ))}
                  </select>
                </Field>
              )}
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("banks.colAccount")}>
                <input
                  className="field" maxLength={80}
                  value={form.bankName}
                  onChange={(e) => setForm({ ...form, bankName: e.target.value })}
                  placeholder="e.g. Meezan Bank"
                />
              </Field>
              <Field label={t("payments.colAccount")}>
                <input
                  className="field" maxLength={40} dir="ltr"
                  value={form.accountNo}
                  onChange={(e) => setForm({ ...form, accountNo: e.target.value })}
                  placeholder="0123-0104567890"
                />
              </Field>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={m("iban")}>
                <input
                  className="field" maxLength={34} dir="ltr"
                  value={form.iban}
                  onChange={(e) => setForm({ ...form, iban: e.target.value })}
                  placeholder={m("ibanPlaceholder")}
                />
              </Field>
              <Field
                label={m("openingBalance")}
                hint={form.accountType === "OVERDRAFT" ? m("overdraftOpeningHint") : undefined}
              >
                <input
                  className="field" dir="ltr" inputMode="decimal"
                  value={form.openingBalance}
                  onChange={(e) => setForm({ ...form, openingBalance: e.target.value })}
                  placeholder="0"
                />
              </Field>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" className="btn btn-ghost text-sm" onClick={() => setModal(false)}>
                {t("common.cancel")}
              </button>
              <button type="submit" className="btn btn-primary text-sm" disabled={saving}>
                {saving ? t("common.saving") : t("common.create")}
              </button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
