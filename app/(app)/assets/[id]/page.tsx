"use client";

// Asset detail: profile, projected depreciation schedule, and movements
// (sell with auto gain/loss, disposal/scrapping, inter-branch transfer).
import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { Factory, X, ArrowRightLeft } from "lucide-react";
import { PageHeader, Field, ErrorNote, StatusPill, SummaryChips } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney, fmtDateInput } from "@/lib/format";

type Asset = {
  id: string; code: string; description: string; serialNumber: string | null;
  assetClass: string; purchaseDate: string; purchaseCostPaisa: string;
  salvageValuePaisa: string; accumDepPaisa: string; status: string;
  depreciationMethod: string; usefulLifeYears: number; dbRateBps: number | null;
  branchId: string | null; salePricePaisa: string; gainLossPaisa: string;
  soldAt: string | null; disposalJournalEntryId: string | null;
};

type SchedRow = { year: number; month: number; depreciationPaisa: string; nbvAfterPaisa: string };
type Branch = { id: string; name: string };
type Bank = { id: string; name: string };

export default function AssetDetailPage() {
  const { t } = useLang();
  const can = useCan("assets");
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [asset, setAsset] = useState<Asset | null>(null);
  const [sched, setSched] = useState<SchedRow[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [banks, setBanks] = useState<Bank[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<"" | "sell" | "dispose" | "transfer">("");
  const [sellPrice, setSellPrice] = useState("");
  const [sellDate, setSellDate] = useState(fmtDateInput(new Date()));
  const [bankId, setBankId] = useState("");
  const [toBranch, setToBranch] = useState("");
  const [dialogErr, setDialogErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, s] = await Promise.all([
        api<{ data: Asset }>(`/api/assets/${id}`),
        api<{ data: { nbvPaisa: string; accumDepPaisa: string; schedule: SchedRow[] } }>(`/api/assets/${id}/schedule`),
      ]);
      setAsset(a.data); setSched(s.data.schedule);
      setError(null);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect -- initial data fetch on mount */
    load();
  }, [load]);
  useEffect(() => {
    api<{ data: Branch[] }>("/api/branches").then((d) => setBranches(d.data)).catch(() => {});
    api<{ data: Bank[] }>("/api/bank-accounts").then((d) => { setBanks(d.data); setBankId(d.data[0]?.id ?? ""); }).catch(() => {});
  }, []);

  if (!can) return <PageHeader title={t("assets.title")} icon={<Factory size={20} />} />;
  if (!asset) return <div className="p-4"><ErrorNote message={error} /></div>;

  const nbv = BigInt(asset.purchaseCostPaisa) - BigInt(asset.accumDepPaisa);
  const held = asset.status === "ACTIVE" || asset.status === "DEPRECIATED";

  const doSell = async () => {
    setBusy(true); setDialogErr(null);
    try {
      await api(`/api/assets/${id}/sell`, {
        method: "POST",
        body: JSON.stringify({ salePrice: sellPrice, date: sellDate, bankAccountId: bankId, idempotencyKey: crypto.randomUUID() }),
      });
      setDialog(""); load();
    } catch (e) { setDialogErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const doDispose = async () => {
    setBusy(true); setDialogErr(null);
    try {
      await api(`/api/assets/${id}/dispose`, {
        method: "POST",
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      });
      setDialog(""); load();
    } catch (e) { setDialogErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const doTransfer = async () => {
    setBusy(true); setDialogErr(null);
    try {
      await api(`/api/assets/${id}/transfer`, {
        method: "POST",
        body: JSON.stringify({ toBranchId: toBranch }),
      });
      setDialog(""); setToBranch(""); load();
    } catch (e) { setDialogErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const doDelete = async () => {
    if (!window.confirm(t("assets.confirmDelete"))) return;
    setBusy(true);
    try {
      await api(`/api/assets/${id}`, { method: "DELETE" });
      router.push("/assets");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const gainLoss = BigInt(asset.gainLossPaisa);

  return (
    <div className="space-y-4">
      <PageHeader
        title={asset.code}
        subtitle={asset.description}
        icon={<Factory size={20} />}
        actions={
          <div className="flex flex-wrap gap-2">
            {held && (
              <>
                <button className="btn btn-primary !py-2 text-sm" onClick={() => { setDialog("sell"); setDialogErr(null); }}>{t("assets.sell")}</button>
                <button className="btn btn-ghost !py-2 text-sm" onClick={() => { setDialog("dispose"); setDialogErr(null); }}>{t("assets.dispose")}</button>
                <button className="btn btn-ghost !py-2 text-sm" onClick={() => { setDialog("transfer"); setDialogErr(null); }}><ArrowRightLeft size={15} />{t("assets.transfer")}</button>
                {BigInt(asset.accumDepPaisa) === 0n && (
                  <button className="btn btn-ghost !py-2 text-sm !text-rose-600" disabled={busy} onClick={doDelete}>{t("common.delete")}</button>
                )}
              </>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />
      <StatusPill status={asset.status} />

      <SummaryChips items={[
        { label: t("assets.purchaseCost"), value: fmtMoney(asset.purchaseCostPaisa) },
        { label: t("assets.accumDep"), value: fmtMoney(asset.accumDepPaisa) },
        { label: t("assets.nbv"), value: fmtMoney(nbv) },
        { label: t("assets.salvageValue"), value: fmtMoney(asset.salvageValuePaisa) },
      ]} />

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-4 text-sm">
          <dl className="space-y-2">
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.assetClass")}</dt><dd className="font-semibold">{asset.assetClass}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.serialNumber")}</dt><dd className="font-semibold">{asset.serialNumber ?? "—"}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.purchaseDate")}</dt><dd className="font-semibold">{fmtDateInput(new Date(asset.purchaseDate))}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.method")}</dt><dd className="font-semibold">{asset.depreciationMethod === "DB" ? `${t("assets.methodDB")} (${asset.dbRateBps != null ? asset.dbRateBps / 100 : 0}%)` : t("assets.methodSL")}</dd></div>
            <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.usefulLife")}</dt><dd className="font-semibold">{asset.usefulLifeYears}</dd></div>
          </dl>
        </div>
        {(asset.status === "SOLD" || asset.status === "DISPOSED") && (
          <div className="rounded-2xl border border-border bg-card p-4 text-sm">
            <h2 className="mb-2 text-sm font-bold">{t("assets.movements")}</h2>
            <dl className="space-y-2">
              {asset.status === "SOLD" && (
                <>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.salePrice")}</dt><dd className="font-semibold">{fmtMoney(asset.salePricePaisa)}</dd></div>
                  <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.gainLoss")}</dt><dd className={`font-semibold ${gainLoss >= 0n ? "text-emerald-600" : "text-rose-600"}`}>{gainLoss >= 0n ? t("assets.gain") : t("assets.loss")}: {fmtMoney(gainLoss < 0n ? -gainLoss : gainLoss)}</dd></div>
                </>
              )}
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">{t("assets.journal")}</dt><dd className="font-mono text-xs">{asset.disposalJournalEntryId?.slice(0, 8) ?? "—"}</dd></div>
            </dl>
          </div>
        )}
      </div>

      {held && sched.length > 0 && (
        <div className="rounded-2xl border border-border bg-card p-4">
          <h2 className="text-sm font-bold">{t("assets.projectedSchedule")}</h2>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[420px] text-sm">
              <thead>
                <tr className="border-b border-border text-start text-xs text-muted-foreground">
                  <th className="p-2 font-semibold">{t("assets.month")}</th>
                  <th className="p-2 text-end font-semibold">{t("assets.depreciation")}</th>
                  <th className="p-2 text-end font-semibold">{t("assets.nbv")}</th>
                </tr>
              </thead>
              <tbody>
                {sched.map((r) => (
                  <tr key={`${r.year}-${r.month}`} className="border-b border-border last:border-0">
                    <td className="p-2 font-mono">{`${r.year}-${String(r.month).padStart(2, "0")}`}</td>
                    <td className="p-2 text-end tabular-nums">{fmtMoney(r.depreciationPaisa)}</td>
                    <td className="p-2 text-end font-semibold tabular-nums">{fmtMoney(r.nbvAfterPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {dialog !== "" && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-4 sm:items-center" onClick={() => setDialog("")}>
          <div className="w-full max-w-md rounded-2xl bg-card p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold">
                {dialog === "sell" ? t("assets.sell") : dialog === "dispose" ? t("assets.dispose") : t("assets.transfer")} — {asset.code}
              </h2>
              <button className="btn btn-ghost !p-2" onClick={() => setDialog("")}><X size={16} /></button>
            </div>
            <ErrorNote message={dialogErr} />
            <div className="mt-4 space-y-3">
              {dialog === "sell" && (
                <>
                  <p className="text-xs text-muted-foreground">{t("assets.confirmSell")}</p>
                  <Field label={t("assets.salePrice")} required>
                    <input inputMode="decimal" className="input" value={sellPrice} onChange={(e) => setSellPrice(e.target.value)} />
                  </Field>
                  <Field label={t("assets.proceedsAccount")} required>
                    <select className="input" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                      {banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </Field>
                  <Field label={t("assets.soldOn")}>
                    <input type="date" className="input" value={sellDate} onChange={(e) => setSellDate(e.target.value)} />
                  </Field>
                </>
              )}
              {dialog === "dispose" && (
                <p className="text-sm">{t("assets.confirmDispose")}</p>
              )}
              {dialog === "transfer" && (
                <Field label={t("assets.branch")} required>
                  <select className="input" value={toBranch} onChange={(e) => setToBranch(e.target.value)}>
                    <option value="">—</option>
                    {branches.filter((b) => b.id !== asset.branchId).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </Field>
              )}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button className="btn btn-ghost" onClick={() => setDialog("")}>{t("common.cancel")}</button>
              {dialog === "sell" && <button className="btn btn-primary" disabled={busy || !sellPrice || !bankId} onClick={doSell}>{t("assets.sell")}</button>}
              {dialog === "dispose" && <button className="btn btn-primary" disabled={busy} onClick={doDispose}>{t("assets.dispose")}</button>}
              {dialog === "transfer" && <button className="btn btn-primary" disabled={busy || !toBranch} onClick={doTransfer}>{t("assets.transfer")}</button>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
