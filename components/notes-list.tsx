"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { PageHeader, EmptyState } from "@/components/ui";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

export type NoteKind = "CREDIT" | "DEBIT";

type NoteRow = {
  id: string; kind: string; docNo: string; date: number; amount: string;
  notes: string | null; partyId: string; partyName: string | null;
  accountName: string | null; sourceDocId: string | null;
};

/** Shared list for /sales/notes (CREDIT) and /purchases/notes (DEBIT). */
export function NotesList({ kind }: { kind: NoteKind }) {
  const { t } = useLang();
  const { permissions } = usePermissions();
  const isCredit = kind === "CREDIT";
  const canPost = permissions.includes(isCredit ? "sales" : "purchases");
  const base = isCredit ? "/sales/notes" : "/purchases/notes";

  const [rows, setRows] = useState<NoteRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const d = await api<{ data: NoteRow[] }>(`/api/notes?kind=${kind}`);
      setRows(d.data);
    } catch { setRows([]); } finally { setLoading(false); }
  }, [kind]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on mount
  useEffect(() => { load(); }, [load]);

  return (
    <div>
      <PageHeader
        title={t(isCredit ? "fix4.note.listCreditTitle" : "fix4.note.listDebitTitle")}
        subtitle={t("fix4.note.listSubtitle")}
        actions={canPost ? (
          <Link href={`${base}/new`} className="btn btn-primary text-sm">
            <Plus size={16} /> {t("fix4.note.newNote")}
          </Link>
        ) : undefined}
      />
      {loading ? (
        <div className="card p-8 text-center text-sm text-muted-foreground">{t("common.loading")}</div>
      ) : rows.length === 0 ? (
        <EmptyState
          title={t(isCredit ? "fix4.note.listCreditTitle" : "fix4.note.listDebitTitle")}
          action={canPost ? <Link href={`${base}/new`} className="btn btn-primary text-sm"><Plus size={16} /> {t("fix4.note.newNote")}</Link> : undefined}
        />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-3">{t("fix4.note.colDoc")}</th>
                <th className="px-4 py-3">{t("fix4.note.colDate")}</th>
                <th className="px-4 py-3">{t("fix4.note.colParty")}</th>
                <th className="px-4 py-3">{t("fix4.note.colNote")}</th>
                <th className="px-4 py-3 text-right">{t("fix4.note.colAmount")}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border/60 last:border-0 hover:bg-muted/40">
                  <td className="px-4 py-2.5">
                    <Link href={`${base}/${r.id}`} className="font-bold text-primary hover:underline">{r.docNo}</Link>
                  </td>
                  <td className="px-4 py-2.5 whitespace-nowrap">{fmtDate(r.date)}</td>
                  <td className="px-4 py-2.5">{r.partyName ?? "—"}</td>
                  <td className="px-4 py-2.5 text-muted-foreground">{r.notes || "—"}</td>
                  <td className="px-4 py-2.5 text-right font-semibold tabular-nums">{fmtMoney(r.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
