"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { PageHeader, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtQty } from "@/lib/format";

type BomDetail = {
  header: { id: string; version: number; isActive: boolean; notes: string | null };
  finished: { name: string; sku: string; unit: string } | null;
  lines: {
    id: string; componentProductId: string; qtyMilli: string; scrapPct: number;
    name: string; sku: string; unit: string;
  }[];
};

export default function BomDetailPage() {
  const params = useParams<{ id: string }>();
  const { t } = useLang();
  const { permissions, loading: permsLoading } = usePermissions();
  const [data, setData] = useState<BomDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canSee = permsLoading || permissions.includes("manufacturing");

  const load = useCallback(async () => {
    try {
      const d = await api<{ data: BomDetail }>(`/api/manufacturing/boms/${params.id}`);
      setData(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("common.loadError"));
    }
  }, [params.id, t]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- detail load
  useEffect(() => { if (canSee) load(); }, [load, canSee]);

  if (!canSee) return null;
  if (error) return <ErrorNote message={error} />;
  if (!data) return <p className="mt-8 text-center text-sm text-muted-foreground">…</p>;

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={`${t("mfg.bomFor")} ${data.finished?.name ?? ""}`}
        subtitle={`${t("mfg.version")} ${data.header.version} · ${data.finished?.sku ?? ""}`}
        actions={
          <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${data.header.isActive ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            {data.header.isActive ? t("mfg.active") : t("mfg.inactive")}
          </span>
        }
      />
      {data.header.notes && <p className="mt-3 text-sm text-muted-foreground">{data.header.notes}</p>}
      <div className="mt-4 overflow-x-auto rounded-2xl border border-border">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="bg-muted/60 text-xs uppercase tracking-wide text-muted-foreground">
              <th className="px-4 py-3 text-start font-bold">{t("mfg.component")}</th>
              <th className="px-4 py-3 text-end font-bold">{t("mfg.qtyPerUnit")}</th>
              <th className="px-4 py-3 text-end font-bold">{t("mfg.scrap")}</th>
            </tr>
          </thead>
          <tbody>
            {data.lines.map((l) => (
              <tr key={l.id} className="border-t border-border">
                <td className="px-4 py-3">{l.name} <span className="text-xs text-muted-foreground">{l.sku}</span></td>
                <td className="px-4 py-3 text-end">{fmtQty(l.qtyMilli, l.unit)}</td>
                <td className="px-4 py-3 text-end">{l.scrapPct}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-muted-foreground">{t("mfg.singleLevelNote")}</p>
    </div>
  );
}
