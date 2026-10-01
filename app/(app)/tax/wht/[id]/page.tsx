"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Printer, ArrowLeft, FileBadge } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { ErrorNote, EmptyState } from "@/components/ui";
import { api } from "@/lib/format";

type CertData = {
  id: string;
  date: string;
  deductor: { name: string; ntn: string | null; strn: string | null; address: string | null };
  deductee: { name: string; ntnCnic: string | null };
  taxSection: string;
  rateBps: number;
  grossFmt: string;
  whtFmt: string;
  cprNo: string | null;
  depositedAt: string | null;
  kind: string;
};

export default function WhtCertificatePage() {
  const { t } = useLang();
  const params = useParams<{ id: string }>();
  const [data, setData] = useState<CertData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ data: CertData }>(`/api/tax/wht-deductions/${params.id}`)
      .then((r) => setData(r.data))
      .catch(() => setError(t("tax.loadError")))
      .finally(() => setLoading(false));
  }, [params.id, t]);

  if (loading) return <p className="p-6 text-sm text-muted-foreground">…</p>;
  if (error) return <div className="p-6"><ErrorNote message={error} /></div>;
  if (!data) return <div className="p-6"><EmptyState title={t("tax.loadError")} icon={<FileBadge className="h-8 w-8" />} /></div>;

  const rows: [string, string][] = [
    [t("tax.certNo"), data.id.slice(0, 8).toUpperCase()],
    [t("tax.certDate"), new Date(data.date).toLocaleDateString("en-PK", { day: "numeric", month: "long", year: "numeric" })],
    [t("tax.certDeductee"), `${data.deductee.name}${data.deductee.ntnCnic ? ` — ${data.deductee.ntnCnic}` : ""}`],
    [t("tax.certSource"), data.kind],
    [t("tax.certSection"), data.taxSection],
    [t("tax.certRate"), `${(data.rateBps / 100).toString()}%`],
    [t("tax.certGross"), data.grossFmt],
    [t("tax.certTax"), data.whtFmt],
    [t("tax.certCpr"), data.cprNo ?? t("tax.certPending")],
  ];

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between print:hidden">
        <Link href="/tax" className="inline-flex items-center gap-2 text-sm font-bold text-primary hover:underline">
          <ArrowLeft className="h-4 w-4 rtl:rotate-180" /> {t("tax.backToRegister")}
        </Link>
        <button type="button" onClick={() => window.print()} className="btn-primary inline-flex items-center gap-2 !px-4 !py-2 text-sm font-bold">
          <Printer className="h-4 w-4" /> {t("tax.print")}
        </button>
      </div>

      <div className="card overflow-hidden p-8 print:border-0 print:shadow-none sm:p-12">
        <div className="text-center">
          <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground">{t("tax.certDeductor")}</p>
          <h1 className="mt-1 text-2xl font-extrabold">{data.deductor.name}</h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {[data.deductor.ntn && `NTN: ${data.deductor.ntn}`, data.deductor.strn && `STRN: ${data.deductor.strn}`].filter(Boolean).join("  ·  ")}
          </p>
          {data.deductor.address && <p className="mt-0.5 text-xs text-muted-foreground">{data.deductor.address}</p>}
        </div>

        <h2 className="mt-8 border-y-2 border-foreground/80 py-3 text-center text-lg font-extrabold uppercase tracking-wide">
          {t("tax.certTitle")}
        </h2>

        <table className="mt-6 w-full text-sm">
          <tbody>
            {rows.map(([label, value], i) => (
              <tr key={i} className={i % 2 ? "bg-muted/40" : ""}>
                <td className="w-1/2 px-4 py-2.5 font-bold text-muted-foreground">{label}</td>
                <td className="px-4 py-2.5 font-extrabold" dir="auto">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="mt-6 text-xs leading-relaxed text-muted-foreground">{t("tax.certNote")}</p>

        <div className="mt-16 flex items-end justify-between">
          <div className="text-center text-xs text-muted-foreground">
            <div className="mx-auto mb-2 h-px w-48 bg-foreground/40" />
            {t("tax.certSign")}
          </div>
          <p className="text-xs text-muted-foreground" dir="ltr">
            {new Date().toLocaleDateString("en-PK", { day: "numeric", month: "short", year: "numeric" })}
          </p>
        </div>
      </div>
    </div>
  );
}
