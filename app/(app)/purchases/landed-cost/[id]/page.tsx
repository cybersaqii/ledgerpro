"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { Ship, ArrowLeft, Ban } from "lucide-react";
import { PageHeader, ErrorNote, StatusPill } from "@/components/ui";
import { Modal } from "@/components/modal";
import { api, fmtMoney, fmtQty, fmtDate, fmtDateInput } from "@/lib/format";
import { localizedApiError } from "@/lib/api-errors";
import { useLang } from "@/components/lang-provider";

type SheetDetail = {
  id: string;
  sheetNo: string;
  date: number | string;
  status: "POSTED" | "VOID";
  basis: string;
  totalPaisa: string;
  branchId: string;
  docLabel: string | null;
  purchaseDocId: string | null;
  heads: { head: string; label: string | null; amountPaisa: string }[];
  lines: {
    productId: string; productName: string | null; sku: string | null; unit: string | null;
    qtyMilli: string; valuePaisa: string; weightScaled: string; allocatedPaisa: string;
  }[];
};

export default function LandedCostDetailPage() {
  const { t } = useLang();
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [sheet, setSheet] = useState<SheetDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [confirmVoid, setConfirmVoid] = useState(false);
  const [voiding, setVoiding] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const d = await api<{ data: SheetDetail }>(`/api/landed-cost/${params.id}`);
      setSheet(d.data);
    } catch (e) {
      setError(localizedApiError(e instanceof Error ? e : null, t, t("landedCost.loadError")));
    } finally { setLoading(false); }
  }, [params.id, t]);

  useEffect(() => { load(); }, [load]);

  async function doVoid() {
    if (!sheet || voiding) return;
    setVoiding(true);
    setError(null);
    try {
      await api(`/api/landed-cost/${sheet.id}/void`, {
        method: "POST",
        body: JSON.stringify({
          date: fmtDateInput(new Date(sheet.date)),
          branchId: sheet.branchId,
        }),
      });
      setConfirmVoid(false);
      router.push("/purchases/landed-cost");
    } catch (e) {
      setError(localizedApiError(e instanceof Error ? e : null, t));
      setVoiding(false);
      setConfirmVoid(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={sheet ? sheet.sheetNo : t("landedCost.title")}
        subtitle={sheet ? `${fmtDate(sheet.date)} · ${t(`landedCost.basis_${sheet.basis}` as never)}` : ""}
        icon={<Ship size={20} />}
        actions={
          <div className="flex gap-2">
            <Link href="/purchases/landed-cost" className="btn btn-ghost text-sm">
              <ArrowLeft size={16} /> {t("common.back")}
            </Link>
            {sheet?.status === "POSTED" && (
              <button className="btn btn-ghost text-sm text-danger" onClick={() => setConfirmVoid(true)}>
                <Ban size={16} /> {t("landedCost.voidSheet")}
              </button>
            )}
          </div>
        }
      />

      <ErrorNote message={error} />

      {loading ? (
        <div className="skeleton h-64 rounded-2xl" />
      ) : !sheet ? (
        <p className="text-sm text-muted-foreground">{t("landedCost.notFound")}</p>
      ) : (
        <div className="space-y-5">
          <div className="card flex flex-wrap items-center gap-x-8 gap-y-3 p-5">
            <div>
              <p className="text-xs text-muted-foreground">{t("common.status")}</p>
              <StatusPill status={sheet.status} />
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("landedCost.source")}</p>
              <p className="text-sm font-bold">{sheet.docLabel ?? "—"}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">{t("landedCost.basis")}</p>
              <p className="text-sm font-bold">{t(`landedCost.basis_${sheet.basis}` as never)}</p>
            </div>
            <div className="ms-auto">
              <p className="text-xs text-muted-foreground">{t("landedCost.total")}</p>
              <p className="text-xl font-extrabold">{fmtMoney(sheet.totalPaisa)}</p>
            </div>
          </div>

          <div className="card p-5">
            <p className="mb-3 text-sm font-bold">{t("landedCost.heads")}</p>
            <table className="table">
              <thead>
                <tr>
                  <th>{t("landedCost.head")}</th>
                  <th>{t("landedCost.headLabel")}</th>
                  <th className="num">{t("landedCost.amount")}</th>
                </tr>
              </thead>
              <tbody>
                {sheet.heads.map((h, i) => (
                  <tr key={i}>
                    <td className="font-semibold">{t(`landedCost.head_${h.head}` as never)}</td>
                    <td className="text-muted-foreground">{h.label || "—"}</td>
                    <td className="num">{fmtMoney(h.amountPaisa)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card p-5">
            <p className="mb-3 text-sm font-bold">{t("landedCost.allocation")}</p>
            <div className="overflow-x-auto">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t("landedCost.product")}</th>
                    <th className="num">{t("landedCost.qtyOnHand")}</th>
                    <th className="num">{t("landedCost.allocated")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sheet.lines.map((l) => (
                    <tr key={l.productId}>
                      <td>
                        <span className="font-semibold">{l.productName ?? l.productId}</span>
                        <span className="block text-[11px] text-muted-foreground">{l.sku ?? ""} · {l.unit ?? ""}</span>
                      </td>
                      <td className="num">{fmtQty(l.qtyMilli, l.unit ?? "")}</td>
                      <td className="num font-extrabold">{fmtMoney(l.allocatedPaisa)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-extrabold">
                    <td colSpan={2}>{t("common.total")}</td>
                    <td className="num">{fmtMoney(sheet.totalPaisa)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>
        </div>
      )}

      {confirmVoid && (
        <Modal title={t("landedCost.voidTitle")} onClose={() => setConfirmVoid(false)}>
          <p className="text-sm text-muted-foreground">{t("landedCost.voidConfirm")}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn btn-ghost" onClick={() => setConfirmVoid(false)}>{t("common.cancel")}</button>
            <button className="btn btn-danger" disabled={voiding} onClick={doVoid}>
              {voiding ? t("common.saving") : t("landedCost.voidSheet")}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
