"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import Link from "next/link";
import { PageHeader, ErrorNote } from "@/components/ui";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type Currency = {
  code: string;
  name: string;
  symbol: string;
  minorUnits: number;
  isBase: boolean;
  isActive: boolean;
  latestRate: { rateScaled: string; rate: string; effectiveDate: string } | null;
};

type RateRow = { id: string; code: string; rateScaled: string; rate: string; effectiveDate: string };

function todayLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export default function CurrenciesPage() {
  const { t } = useLang();
  const { permissions, role, loading: permsLoading } = usePermissions();
  const canManage = !permsLoading && (role === "OWNER" || permissions.includes("settings"));

  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newUnits, setNewUnits] = useState("2");
  const [adding, setAdding] = useState(false);

  const [rateCode, setRateCode] = useState("");
  const [rateValue, setRateValue] = useState("");
  const [rateDate, setRateDate] = useState(todayLabel());
  const [savingRate, setSavingRate] = useState(false);

  const [histCode, setHistCode] = useState("");
  const [history, setHistory] = useState<RateRow[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: Currency[] }>("/api/currencies");
      setCurrencies(res.data);
      if (!rateCode && res.data.length > 0) {
        const first = res.data.find((c) => !c.isBase) ?? res.data[0];
        setRateCode(first.code);
        setHistCode(first.code);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("settingscurrencies.loadError"));
    } finally {
      setLoading(false);
    }
  }, [rateCode, t]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch currency list on mount / language change (async loader)
    load();
  }, [load]);

  const loadHistory = useCallback(
    async (code: string) => {
      if (!code) return;
      setHistLoading(true);
      try {
        const res = await api<{ data: RateRow[] }>(`/api/currencies/rates?code=${encodeURIComponent(code)}`);
        setHistory(res.data);
      } catch (e) {
        setError(e instanceof Error ? e.message : t("settingscurrencies.loadError"));
      } finally {
        setHistLoading(false);
      }
    },
    [t]
  );

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch rate history when the selected currency changes (async loader)
    if (histCode) loadHistory(histCode);
  }, [histCode, loadHistory]);

  const foreignCurrencies = useMemo(() => currencies.filter((c) => !c.isBase), [currencies]);

  async function addCurrency(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/currencies", {
        method: "POST",
        body: JSON.stringify({
          code: newCode,
          name: newName,
          symbol: newSymbol,
          minorUnits: parseInt(newUnits, 10),
        }),
      });
      setNewCode("");
      setNewName("");
      setNewSymbol("");
      setNewUnits("2");
      setNotice(t("settingscurrencies.added"));
      await load();
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : t("settingscurrencies.saveError"));
    } finally {
      setAdding(false);
    }
  }

  async function saveRate(e: React.FormEvent) {
    e.preventDefault();
    setSavingRate(true);
    setError(null);
    setNotice(null);
    try {
      await api("/api/currencies/rates", {
        method: "POST",
        body: JSON.stringify({ code: rateCode, rate: rateValue, effectiveDate: rateDate }),
      });
      setRateValue("");
      setNotice(t("settingscurrencies.rateSaved"));
      await load();
      if (histCode === rateCode) await loadHistory(rateCode);
    } catch (e2) {
      setError(e2 instanceof Error ? e2.message : t("settingscurrencies.saveError"));
    } finally {
      setSavingRate(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl p-4 sm:p-6">
      <Link href="/settings" className="mb-4 inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-primary">
        <ArrowLeft size={15} className="rtl:rotate-180" /> {t("settingscurrencies.backToSettings")}
      </Link>
      <PageHeader title={t("settingscurrencies.title")} subtitle={t("settingscurrencies.hint")} />

      {error && <div className="mt-4"><ErrorNote message={error} /></div>}
      {notice && (
        <div className="mt-4 rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-sm font-semibold text-success">
          {notice}
        </div>
      )}

      <div className="card mt-6 p-5 sm:p-6">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-base font-extrabold">{t("settingscurrencies.listTitle")}</h2>
          <button onClick={load} className="btn btn-ghost text-xs" disabled={loading}>
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> {t("settingscurrencies.refresh")}
          </button>
        </div>
        {loading ? (
          <p className="mt-4 text-sm text-muted-foreground">{t("settingscurrencies.loading")}</p>
        ) : currencies.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{t("settingscurrencies.empty")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pe-3 text-start font-bold">{t("settingscurrencies.colCode")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("settingscurrencies.colName")}</th>
                  <th className="py-2 pe-3 text-start font-bold">{t("settingscurrencies.colUnits")}</th>
                  <th className="py-2 text-start font-bold">{t("settingscurrencies.colRate")}</th>
                </tr>
              </thead>
              <tbody>
                {currencies.map((c) => (
                  <tr key={c.code} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pe-3 font-extrabold">
                      {c.code}
                      {c.isBase && (
                        <span className="ms-2 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-bold text-primary">
                          {t("settingscurrencies.baseBadge")}
                        </span>
                      )}
                    </td>
                    <td className="py-2.5 pe-3 text-muted-foreground">{c.name}{c.symbol ? ` (${c.symbol})` : ""}</td>
                    <td className="py-2.5 pe-3 text-muted-foreground">{c.minorUnits}</td>
                    <td className="py-2.5">
                      {c.isBase ? (
                        <span className="text-muted-foreground">1.000000</span>
                      ) : c.latestRate ? (
                        <span>
                          <span className="font-bold">{c.latestRate.rate}</span>{" "}
                          <span className="text-xs text-muted-foreground">
                            {t("settingscurrencies.perUnit", { date: c.latestRate.effectiveDate })}
                          </span>
                        </span>
                      ) : (
                        <span className="text-xs font-semibold text-warning">
                          {t("settingscurrencies.noRate")}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted-foreground">{t("settingscurrencies.rateBasisNote")}</p>
      </div>

      {canManage && (
        <>
          <div className="card mt-6 p-5 sm:p-6">
            <h2 className="text-base font-extrabold">{t("settingscurrencies.addTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("settingscurrencies.addHint")}</p>
            <form onSubmit={addCurrency} className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <label className="text-xs font-bold">
                {t("settingscurrencies.colCode")}
                <input value={newCode} onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  placeholder="AED" maxLength={3} required
                  className="input mt-1 w-full uppercase" />
              </label>
              <label className="text-xs font-bold">
                {t("settingscurrencies.colName")}
                <input value={newName} onChange={(e) => setNewName(e.target.value)}
                  placeholder={t("settingscurrencies.namePlaceholder")} maxLength={60} required
                  className="input mt-1 w-full" />
              </label>
              <label className="text-xs font-bold">
                {t("settingscurrencies.colSymbol")}
                <input value={newSymbol} onChange={(e) => setNewSymbol(e.target.value)}
                  placeholder="د.إ" maxLength={6}
                  className="input mt-1 w-full" />
              </label>
              <label className="text-xs font-bold">
                {t("settingscurrencies.colUnits")}
                <input value={newUnits} onChange={(e) => setNewUnits(e.target.value)}
                  type="number" min={0} max={6} required
                  className="input mt-1 w-full" />
              </label>
              <div className="col-span-2 sm:col-span-4">
                <button className="btn btn-primary text-sm" disabled={adding}>
                  <Plus size={15} /> {adding ? t("settingscurrencies.saving") : t("settingscurrencies.addButton")}
                </button>
              </div>
            </form>
          </div>

          <div className="card mt-6 p-5 sm:p-6">
            <h2 className="text-base font-extrabold">{t("settingscurrencies.rateTitle")}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t("settingscurrencies.rateHint")}</p>
            <form onSubmit={saveRate} className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-4">
              <label className="text-xs font-bold">
                {t("settingscurrencies.colCode")}
                <select value={rateCode} onChange={(e) => setRateCode(e.target.value)} required className="input mt-1 w-full">
                  {foreignCurrencies.map((c) => (
                    <option key={c.code} value={c.code}>{c.code} — {c.name}</option>
                  ))}
                </select>
              </label>
              <label className="text-xs font-bold">
                {t("settingscurrencies.rateLabel")}
                <input value={rateValue} onChange={(e) => setRateValue(e.target.value)}
                  placeholder="76.500000" required inputMode="decimal"
                  className="input mt-1 w-full" dir="ltr" />
              </label>
              <label className="text-xs font-bold">
                {t("settingscurrencies.dateLabel")}
                <input type="date" value={rateDate} max={todayLabel()}
                  onChange={(e) => setRateDate(e.target.value)} required
                  className="input mt-1 w-full" />
              </label>
              <div className="flex items-end">
                <button className="btn btn-primary text-sm" disabled={savingRate || !rateCode}>
                  {savingRate ? t("settingscurrencies.saving") : t("settingscurrencies.saveRate")}
                </button>
              </div>
            </form>
          </div>
        </>
      )}

      <div className="card mt-6 p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-extrabold">{t("settingscurrencies.historyTitle")}</h2>
          <label className="flex items-center gap-2 text-xs font-bold">
            {t("settingscurrencies.colCode")}
            <select value={histCode} onChange={(e) => setHistCode(e.target.value)} className="input w-auto">
              {currencies.filter((c) => !c.isBase).map((c) => (
                <option key={c.code} value={c.code}>{c.code}</option>
              ))}
            </select>
          </label>
        </div>
        {histLoading ? (
          <p className="mt-4 text-sm text-muted-foreground">{t("settingscurrencies.loading")}</p>
        ) : history.length === 0 ? (
          <p className="mt-4 text-sm text-muted-foreground">{t("settingscurrencies.historyEmpty")}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="py-2 pe-3 text-start font-bold">{t("settingscurrencies.dateLabel")}</th>
                  <th className="py-2 text-start font-bold">{t("settingscurrencies.rateLabel")}</th>
                </tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={r.id} className="border-b border-border/60 last:border-0">
                    <td className="py-2.5 pe-3 text-muted-foreground">{r.effectiveDate}</td>
                    <td className="py-2.5 font-bold" dir="ltr">{r.rate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
