"use client";

// Fixed assets home: the asset register (list + new-asset dialog),
// with a link to the monthly depreciation runs.
import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Factory, Plus, CalendarClock, ChevronRight, X } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState, StatusPill, FilterBar } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Asset = {
  id: string; code: string; description: string; assetClass: string;
  purchaseDate: string; purchaseCostPaisa: string; salvageValuePaisa: string;
  accumDepPaisa: string; status: string; depreciationMethod: string;
};

type Account = { id: string; code: string; name: string };
type Branch = { id: string; name: string };

const CLASSES = ["VEHICLE", "MACHINERY", "FURNITURE", "IT_EQUIPMENT", "BUILDING", "OTHER"] as const;

export default function AssetsPage() {
  const { t } = useLang();
  const router = useRouter();
  const can = useCan("assets");
  const [list, setList] = useState<Asset[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formErr, setFormErr] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showDepreciation, setShowDepreciation] = useState(false);

  // New-asset form
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [f, setF] = useState({
    code: "", description: "", serialNumber: "", assetClass: "OTHER",
    accountId: "", accumDepAccountId: "", branchId: "",
    purchaseDate: fmtDateInput(new Date()), purchaseCost: "", salvageValue: "",
    depreciationMethod: "SL", usefulLifeYears: 5, annualRate: "20",
  });

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: Asset[] }>("/api/assets");
      setList(d.data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);

  const openDialog = async () => {
    setFormErr(null);
    try {
      const [a, b] = await Promise.all([
        api<{ data: Account[] }>("/api/accounts?type=ASSET"),
        api<{ data: Branch[] }>("/api/branches"),
      ]);
      setAccounts(
        [...a.data].sort((x, y) =>
          (y.code >= "1400" && y.code <= "1499" ? 1 : 0) - (x.code >= "1400" && x.code <= "1499" ? 1 : 0)
        )
      );
      setBranches(b.data);
      // Cost account: prefer a 1401-1499 fixed-asset cost account (1400 is Accumulated Depreciation — a contra account, not a cost account)
      const costAccount = a.data.find((x) => x.code >= "1401" && x.code <= "1499")
        ?? a.data.find((x) => x.code >= "1400" && x.code <= "1499" && x.code !== "1400");
      setF((p) => ({ ...p, accountId: costAccount?.id ?? a.data[0]?.id ?? "" }));
    } catch { /* keep dialog usable even if lookups fail */ }
    setOpen(true);
  };

  if (!can) return <PageHeader title={t("assets.title")} icon={<Factory size={20} />} />;

  const filtered = status ? list.filter((a) => a.status === status) : list;
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));

  const create = async () => {
    setBusy(true);
    setFormErr(null);
    try {
      const d = await api<{ data: { id: string } }>("/api/assets", {
        method: "POST",
        body: JSON.stringify({
          ...f,
          usefulLifeYears: Number(f.usefulLifeYears),
          annualRate: f.annualRate === "" ? null : Number(f.annualRate),
          serialNumber: f.serialNumber || null,
          accumDepAccountId: f.accumDepAccountId || null,
          branchId: f.branchId || null,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      setOpen(false);
      setF((p) => ({ ...p, code: "", description: "", serialNumber: "", purchaseCost: "", salvageValue: "" }));
      router.push(`/assets/${d.data.id}`);
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const nbv = (a: Asset) => BigInt(a.purchaseCostPaisa) - BigInt(a.accumDepPaisa);

  return (
    <div className="space-y-4">
      <PageHeader
        title={t("assets.title")}
        icon={<Factory size={20} />}
        actions={
          <div className="flex flex-wrap gap-2">
            <Link href="/assets/runs" className="btn btn-ghost !py-2 text-sm"><CalendarClock size={15} />{t("assets.runs")}</Link>
            <button className="btn btn-primary !py-2 text-sm" onClick={openDialog}><Plus size={15} />{t("assets.newAsset")}</button>
          </div>
        }
      />
      <ErrorNote message={error} />

      <FilterBar>
        <select className="input w-auto" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">{t("assets.status")}: —</option>
          {["ACTIVE", "DEPRECIATED", "SOLD", "DISPOSED"].map((s) => (
            <option key={s} value={s}>{t(`assets.statuses.${s}`)}</option>
          ))}
        </select>
      </FilterBar>

      {filtered.length === 0 ? (
        <EmptyState title={t("assets.noAssets")} hint={t("assets.noAssetsHint")} icon={<Factory size={28} />} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-border bg-card">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-start text-xs text-muted-foreground">
                <th className="p-3 font-semibold">{t("assets.assetCode")}</th>
                <th className="p-3 font-semibold">{t("assets.description")}</th>
                <th className="p-3 text-end font-semibold">{t("assets.purchaseCost")}</th>
                <th className="p-3 text-end font-semibold">{t("assets.accumDep")}</th>
                <th className="p-3 text-end font-semibold">{t("assets.nbv")}</th>
                <th className="p-3 font-semibold">{t("assets.status")}</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((a) => (
                <tr key={a.id} className="border-b border-border last:border-0 hover:bg-muted/40">
                  <td className="p-3 font-mono font-bold">{a.code}</td>
                  <td className="p-3">{a.description}</td>
                  <td className="p-3 text-end tabular-nums">{fmtMoney(a.purchaseCostPaisa)}</td>
                  <td className="p-3 text-end tabular-nums">{fmtMoney(a.accumDepPaisa)}</td>
                  <td className="p-3 text-end font-semibold tabular-nums">{fmtMoney(nbv(a))}</td>
                  <td className="p-3"><StatusPill status={a.status} /></td>
                  <td className="p-3 text-end">
                    <Link href={`/assets/${a.id}`} className="btn btn-ghost !p-2"><ChevronRight size={16} /></Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={() => setOpen(false)}>
          <div className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-3xl border border-border/60 bg-card p-6 shadow-2xl shadow-black/20 sm:p-7" onClick={(e) => e.stopPropagation()}>
            {/* Premium header */}
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3.5">
                <span className="tile tile-primary h-12 w-12 shrink-0 !rounded-2xl">
                  <Factory size={22} />
                </span>
                <div>
                  <h2 className="font-display text-lg font-extrabold tracking-tight">{t("assets.newAsset")}</h2>
                  <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t("assets.newAssetHint")}</p>
                </div>
              </div>
              <button className="btn btn-ghost !p-2 !rounded-xl shrink-0" onClick={() => setOpen(false)} aria-label={t("common.close")}>
                <X size={16} />
              </button>
            </div>
            <ErrorNote message={formErr} />

            {/* Essentials — clear bordered fields like customer dialog */}
            <div className="mt-5">
              <p className="mb-3 text-[0.7rem] font-extrabold uppercase tracking-widest text-primary">
                {t("assets.essentials")}
              </p>
              <div className="space-y-4">
                <Field label={t("assets.description")} required hint={t("assets.descriptionHint")}>
                  <input className="input !rounded-xl !border-2 !border-border bg-background" value={f.description} onChange={set("description")} placeholder={t("assets.descriptionPh")} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("assets.purchaseCost")} required>
                    <input inputMode="decimal" className="input !rounded-xl !border-2 !border-border bg-background text-lg font-bold tabular-nums" value={f.purchaseCost} onChange={set("purchaseCost")} placeholder="0.00" />
                  </Field>
                  <Field label={t("assets.purchaseDate")} required>
                    <input type="date" className="input !rounded-xl !border-2 !border-border bg-background" value={f.purchaseDate} onChange={set("purchaseDate")} />
                  </Field>
                </div>
              </div>
            </div>

            {/* Advanced details — premium collapsible */}
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="mt-3 flex w-full items-center justify-between rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm font-bold shadow-sm transition hover:border-primary/40 hover:shadow-md"
            >
              <span className="flex items-center gap-2.5">
                <span className={`grid h-8 w-8 place-items-center rounded-xl transition ${showAdvanced ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  <Plus size={15} className={`transition-transform ${showAdvanced ? "rotate-45" : ""}`} />
                </span>
                {t("assets.moreDetails")}
              </span>
              <ChevronRight size={16} className={`text-muted-foreground transition-transform duration-200 ${showAdvanced ? "rotate-90" : ""}`} />
            </button>
            {showAdvanced && (
              <div className="mt-3 grid grid-cols-1 gap-3 rounded-2xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2">
                <Field label={t("assets.assetCode")} hint={t("assets.assetCodeHint")}>
                  <input className="input !rounded-xl !border-2 !border-border bg-background" value={f.code} onChange={set("code")} placeholder="AST-0001" />
                </Field>
                <Field label={t("assets.assetClass")}>
                  <select className="input !rounded-xl !border-2 !border-border bg-background" value={f.assetClass} onChange={set("assetClass")}>
                    {CLASSES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </Field>
                <Field label={t("assets.serialNumber")}>
                  <input className="input !rounded-xl !border-2 !border-border bg-background" value={f.serialNumber} onChange={set("serialNumber")} />
                </Field>
                <Field label={t("assets.branch")}>
                  <select className="input !rounded-xl !border-2 !border-border bg-background" value={f.branchId} onChange={set("branchId")}>
                    <option value="">—</option>
                    {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label={t("assets.assetAccount")} hint={t("assets.assetAccountHint")}>
                    <select className="input !rounded-xl !border-2 !border-border bg-background" value={f.accountId} onChange={set("accountId")}>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Field label={t("assets.accumDepAccount")} hint={t("assets.accumDepHint")}>
                    <select className="input !rounded-xl !border-2 !border-border bg-background" value={f.accumDepAccountId} onChange={set("accumDepAccountId")}>
                      <option value="">{t("assets.sharedAccumDep")}</option>
                      {accounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
                    </select>
                  </Field>
                </div>
              </div>
            )}

            {/* Depreciation — premium collapsible */}
            <button
              type="button"
              onClick={() => setShowDepreciation((v) => !v)}
              className="mt-3 flex w-full items-center justify-between rounded-2xl border border-border/60 bg-card px-4 py-3 text-sm font-bold shadow-sm transition hover:border-primary/40 hover:shadow-md"
            >
              <span className="flex items-center gap-2.5">
                <span className={`grid h-8 w-8 place-items-center rounded-xl transition ${showDepreciation ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                  <CalendarClock size={15} />
                </span>
                {t("assets.depreciationSettings")}
              </span>
              <ChevronRight size={16} className={`text-muted-foreground transition-transform duration-200 ${showDepreciation ? "rotate-90" : ""}`} />
            </button>
            {showDepreciation && (
              <div className="mt-3 grid grid-cols-1 gap-3 rounded-2xl border border-border/60 bg-muted/20 p-4 sm:grid-cols-2">
                <Field label={t("assets.usefulLife")} required hint={t("assets.usefulLifeHint")}>
                  <input type="number" min={1} max={100} className="input !rounded-xl !border-2 !border-border bg-background" value={f.usefulLifeYears} onChange={set("usefulLifeYears")} />
                </Field>
                <Field label={t("assets.method")} required hint={t("assets.methodHint")}>
                  <select className="input !rounded-xl !border-2 !border-border bg-background" value={f.depreciationMethod} onChange={set("depreciationMethod")}>
                    <option value="SL">{t("assets.methodSL")}</option>
                    <option value="DB">{t("assets.methodDB")}</option>
                  </select>
                </Field>
                <Field label={t("assets.salvageValue")} hint={t("assets.salvageValueHint")}>
                  <input inputMode="decimal" className="input !rounded-xl bg-card tabular-nums" value={f.salvageValue} onChange={set("salvageValue")} placeholder="0.00" />
                </Field>
                {f.depreciationMethod === "DB" && (
                  <Field label={t("assets.annualRate")} required hint={t("assets.annualRateHint")}>
                    <input inputMode="decimal" className="input !rounded-xl !border-2 !border-border bg-background" value={f.annualRate} onChange={set("annualRate")} />
                  </Field>
                )}
              </div>
            )}

            {/* Premium actions */}
            <div className="mt-6 flex justify-end gap-2.5 border-t border-border/60 pt-5">
              <button className="btn btn-ghost !rounded-xl !px-5" onClick={() => setOpen(false)}>{t("common.cancel")}</button>
              <button className="btn btn-primary !rounded-xl !px-6 shadow-lg shadow-primary/25 transition hover:shadow-xl hover:shadow-primary/30" disabled={busy || !f.description || !f.accountId || !f.purchaseCost} onClick={create}>
                {busy ? "…" : <><Plus size={16} /> {t("assets.newAsset")}</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
