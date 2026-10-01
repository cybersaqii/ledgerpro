"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Landmark } from "lucide-react";
import { PageHeader, ErrorNote, Switch } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { api, fmtMoney } from "@/lib/format";

type Bank = {
  id: string; name: string; kind: string;
  bankName: string | null; accountNo: string | null;
  balance: string; isActive: boolean;
};

export default function BanksPage() {
  const { t } = useLang();
  const [banks, setBanks] = useState<Bank[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  function kindLabel(kind: string) {
    if (kind === "CASH") return t("banks.kindCash");
    if (kind === "WALLET") return t("banks.kindWallet");
    return t("banks.kindBank");
  }

  return (
    <div>
      <PageHeader
        title={t("banks.title")}
        subtitle={t("banks.subtitle")}
        icon={<Landmark size={20} />}
        actions={
          <Link href="/payments" className="btn btn-ghost text-sm">
            <ArrowLeft size={16} className="rtl:rotate-180" /> {t("banks.backToPayments")}
          </Link>
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
                      {(b.bankName || b.accountNo) && (
                        <div className="text-xs text-muted-foreground">
                          {[b.bankName, b.accountNo].filter(Boolean).join(" · ")}
                        </div>
                      )}
                    </td>
                    <td>{kindLabel(b.kind)}</td>
                    <td className="num font-bold">{fmtMoney(b.balance)}</td>
                    <td>
                      <div className="flex items-center justify-end gap-2">
                        <span className={`text-xs font-bold ${b.isActive ? "text-primary" : "text-muted-foreground"}`}>
                          {b.isActive ? t("banks.active") : t("banks.inactive")}
                        </span>
                        <Switch
                          checked={b.isActive}
                          disabled={busyId === b.id}
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
    </div>
  );
}
