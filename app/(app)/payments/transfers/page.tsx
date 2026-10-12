"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus, ArrowLeftRight } from "lucide-react";
import { PageHeader, EmptyState, Pagination } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

type TransferRow = {
  id: string; docNo: string; date: number;
  fromBankAccountId: string; toBankAccountId: string;
  fromName: string | null; toName: string | null;
  amount: string; feeAmount: string; notes: string | null;
};
const PER_PAGE = 20;

export default function TransfersPage() {
  const { t } = useLang();
  const f = (k: string, vars?: Record<string, string | number>) => t(k, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");

  const [rows, setRows] = useState<TransferRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);

  // One idempotency key per user submission: kept across save attempts so a
  // retry after a network blip replays instead of double-creating. Cleared
  // on success so the next transfer gets a fresh key.

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: TransferRow[]; total: number }>(`/api/transfers?page=${page}&perPage=${PER_PAGE}`);
      setRows(d.data);
      setTotal(d.total);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [page]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount/page change
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title={f("fix3.trTitle")}
        subtitle={f("fix3.trSubtitle")}
        icon={<ArrowLeftRight size={20} />}
        actions={canPost ? (
          <Link href="/bank/transfers/new" className="btn btn-primary text-sm"><Plus size={16} /> {f("fix3.trNew")}</Link>
        ) : undefined}
      />

      <div className="card rise rise-1 overflow-hidden">
        {loading ? (
          <div className="space-y-3 p-5">{[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
        ) : rows.length === 0 ? (
          <EmptyState title={f("fix3.trEmpty")} hint={f("fix3.trEmptyHint")}
            action={canPost ? <Link href="/bank/transfers/new" className="btn btn-primary text-sm"><Plus size={16} /> {f("fix3.trNew")}</Link> : undefined} />
        ) : (
          <div className="overflow-x-auto">
            <table className="tbl">
              <thead><tr>
                <th>{f("fix3.trColDoc")}</th><th>{f("fix3.trColDate")}</th>
                <th>{f("fix3.trColFrom")}</th><th>{f("fix3.trColTo")}</th>
                <th className="num">{f("fix3.trColAmount")}</th>
                <th className="num">{t("m3banking.colFee")}</th>
              </tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="font-bold whitespace-nowrap">{r.docNo}</td>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(r.date)}</td>
                    <td>{r.fromName ?? "—"}</td>
                    <td>{r.toName ?? "—"}</td>
                    <td className="num font-extrabold">{fmtMoney(r.amount)}</td>
                    <td className="num text-muted-foreground">{BigInt(r.feeAmount ?? "0") !== 0n ? fmtMoney(r.feeAmount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Pagination page={page} perPage={PER_PAGE} total={total} onPage={setPage} />
    </div>
  );
}
