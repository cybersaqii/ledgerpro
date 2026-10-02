"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CheckCircle2, Download, FileUp, TriangleAlert, Upload } from "lucide-react";
import { PageHeader, ErrorNote } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api } from "@/lib/format";

/** Field keys mirror lib/importer.ts fieldsFor — the stable CSV contract. */
const FIELDS: Record<string, { field: string; required: boolean }[]> = {
  products: [
    { field: "sku", required: true },
    { field: "name", required: true },
    { field: "barcode", required: false },
    { field: "category", required: false },
    { field: "unit", required: false },
    { field: "purchasePrice", required: false },
    { field: "salePrice", required: false },
    { field: "trackStock", required: false },
  ],
  parties: [
    { field: "name", required: true },
    { field: "type", required: false },
    { field: "phone", required: false },
    { field: "email", required: false },
    { field: "address", required: false },
    { field: "city", required: false },
    { field: "creditLimit", required: false },
  ],
  opening_stock: [
    { field: "sku", required: true },
    { field: "qty", required: true },
    { field: "rate", required: false },
  ],
};

type Kind = keyof typeof FIELDS;
type Step = "kind" | "upload" | "map" | "validate" | "done";

type ValResult = {
  kind: string;
  totalRows: number;
  validCount: number;
  skipped: number;
  errorCount: number;
  errors: { row: number; message: string }[];
};

type LogRow = {
  id: string; kind: string; fileName: string | null; totalRows: number;
  importedRows: number; skippedRows: number; errorCount: number;
  errors: { row: number; message: string }[]; status: string; createdAt: number | string;
};

export default function ImportWizardPage() {
  const { t } = useLang();
  const canImport = useCan("import_export");
  const [step, setStep] = useState<Step>("kind");
  const [kind, setKind] = useState<Kind>("products");
  const [file, setFile] = useState<File | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ValResult | null>(null);
  const [done, setDone] = useState<{ imported: number; skipped: number } | null>(null);
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [openLog, setOpenLog] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ data: LogRow[] }>("/api/import?log=1")
      .then((d) => setLogs(d.data))
      .catch(() => {});
  }, []);

  if (!canImport) {
    return (
      <div>
        <PageHeader title={t("imp.title")} subtitle={t("imp.subtitle")} />
        <ErrorNote message={t("imp.noPermission")} />
      </div>
    );
  }

  function pickKind(k: Kind) {
    setKind(k);
    setFile(null);
    setHeaders([]);
    setMapping({});
    setResult(null);
    setDone(null);
    setStep("upload");
  }

  function onFile(f: File | undefined) {
    if (!f) return;
    setFile(f);
    setError(null);
    // Preview the header row client-side for the mapping step (the server
    // does the real parse; quoted commas in headers are rare and harmless
    // here because mapping is confirmed against server validation).
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      const firstLine = text.split(/\r?\n/)[0] ?? "";
      const hs = firstLine.split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
      setHeaders(hs.filter((h) => h.length > 0));
      // Seed the mapping with the server's auto-guess once the step opens.
      const m: Record<string, string> = {};
      for (const f of FIELDS[kind]) {
        const idx = hs.findIndex((h) => h.toLowerCase().includes(f.field.toLowerCase()) ||
          aliasMatch(h, f.field));
        if (idx >= 0) m[f.field] = String(idx);
      }
      setMapping(m);
      setStep("map");
    };
    reader.readAsText(f.slice(0, 65536));
  }

  async function runValidate() {
    if (!file) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("mode", "validate");
      fd.append("file", file);
      const map: Record<string, number | null> = {};
      for (const f of FIELDS[kind]) {
        const v = mapping[f.field];
        map[f.field] = v === undefined || v === "" ? null : parseInt(v, 10);
      }
      fd.append("mapping", JSON.stringify(map));
      const d = await api<{ data: ValResult }>("/api/import", { method: "POST", body: fd });
      setResult(d.data);
      setStep("validate");
    } catch (e) {
      setError(e instanceof Error ? e.message : t("imp.failed"));
    } finally { setBusy(false); }
  }

  async function runImport() {
    if (!file || !result || result.errorCount > 0) return;
    setBusy(true); setError(null);
    try {
      const fd = new FormData();
      fd.append("kind", kind);
      fd.append("mode", "import");
      fd.append("file", file);
      const map: Record<string, number | null> = {};
      for (const f of FIELDS[kind]) {
        const v = mapping[f.field];
        map[f.field] = v === undefined || v === "" ? null : parseInt(v, 10);
      }
      fd.append("mapping", JSON.stringify(map));
      const d = await api<{ data: { imported: number; skipped: number } }>("/api/import", { method: "POST", body: fd });
      setDone(d.data);
      setStep("done");
      api<{ data: LogRow[] }>("/api/import?log=1").then((x) => setLogs(x.data)).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : t("imp.failed"));
    } finally { setBusy(false); }
  }

  const steps: Step[] = ["kind", "upload", "map", "validate", "done"];
  const stepIdx = steps.indexOf(step);

  return (
    <div>
      <PageHeader title={t("imp.title")} subtitle={t("imp.subtitle")} />
      {error && <ErrorNote message={error} />}

      {/* stepper */}
      <ol className="mb-6 flex flex-wrap items-center gap-2 text-xs font-semibold">
        {steps.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span className={`flex h-6 w-6 items-center justify-center rounded-full ${i <= stepIdx ? "bg-primary text-white" : "bg-muted text-muted-foreground"}`}>
              {i < stepIdx ? <CheckCircle2 size={14} /> : i + 1}
            </span>
            <span className={i <= stepIdx ? "" : "text-muted-foreground"}>{t(`imp.step${s[0].toUpperCase()}${s.slice(1)}`)}</span>
            {i < steps.length - 1 && <span className="text-muted-foreground">·</span>}
          </li>
        ))}
      </ol>

      {step === "kind" && (
        <div className="grid gap-4 sm:grid-cols-3">
          {(Object.keys(FIELDS) as Kind[]).map((k) => (
            <button key={k} type="button" onClick={() => pickKind(k)}
              className="card card-lift p-6 text-start">
              <p className="text-base font-extrabold">{t(`imp.kind${k === "opening_stock" ? "OpeningStock" : k[0].toUpperCase() + k.slice(1)}`)}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t(`imp.kind${k === "opening_stock" ? "OpeningStock" : k[0].toUpperCase() + k.slice(1)}Hint`)}</p>
            </button>
          ))}
        </div>
      )}

      {step === "upload" && (
        <div className="card mx-auto max-w-2xl p-6 sm:p-8">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-lg font-extrabold">{t(`imp.kind${kind === "opening_stock" ? "OpeningStock" : kind[0].toUpperCase() + kind.slice(1)}`)}</h2>
            <a href={`/api/import?kind=${kind}`} className="btn btn-ghost text-sm" download>
              <Download size={15} /> {t("imp.downloadTemplate")}
            </a>
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{t("imp.excelNote")}</p>
          <label className="mt-6 flex cursor-pointer flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-border p-10 text-center hover:border-primary">
            <FileUp size={32} className="text-muted-foreground" />
            <span className="text-sm font-bold">{file ? file.name : t("imp.chooseFile")}</span>
            <span className="text-xs text-muted-foreground">{t("imp.csvOnly")}</span>
            <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
              onChange={(e) => { onFile(e.target.files?.[0]); e.target.value = ""; }} />
          </label>
          <div className="mt-6 flex gap-2">
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setStep("kind")}>
              <ArrowLeft size={15} /> {t("common.back")}
            </button>
          </div>
        </div>
      )}

      {step === "map" && (
        <div className="card mx-auto max-w-2xl p-6 sm:p-8">
          <h2 className="text-lg font-extrabold">{t("imp.mapTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("imp.mapHint", { file: file?.name ?? "" })}</p>
          <div className="mt-4 space-y-3">
            {FIELDS[kind].map((f) => (
              <div key={f.field} className="flex items-center gap-3">
                <label className="w-40 shrink-0 text-sm font-bold">
                  {t(`imp.field_${f.field}`)}{f.required && <span className="text-danger"> *</span>}
                </label>
                <select className="field" value={mapping[f.field] ?? ""}
                  onChange={(e) => setMapping((m) => ({ ...m, [f.field]: e.target.value }))}>
                  <option value="">{t("imp.notMapped")}</option>
                  {headers.map((h, i) => (
                    <option key={i} value={String(i)}>{h}</option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="mt-6 flex gap-2">
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setStep("upload")}>
              <ArrowLeft size={15} /> {t("common.back")}
            </button>
            <button type="button" className="btn btn-primary text-sm" disabled={busy} onClick={runValidate}>
              {busy ? t("imp.validating") : t("imp.validateBtn")} <ArrowRight size={15} />
            </button>
          </div>
        </div>
      )}

      {step === "validate" && result && (
        <div className="card mx-auto max-w-3xl p-6 sm:p-8">
          <h2 className="text-lg font-extrabold">{t("imp.valTitle")}</h2>
          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label={t("imp.totalRows")} value={result.totalRows} />
            <Stat label={t("imp.validRows")} value={result.validCount} tone="text-primary" />
            <Stat label={t("imp.skippedRows")} value={result.skipped} />
            <Stat label={t("imp.errorRows")} value={result.errorCount} tone={result.errorCount > 0 ? "text-danger" : ""} />
          </div>
          {result.errorCount > 0 ? (
            <>
              <p className="mt-4 flex items-start gap-2 text-sm font-semibold text-danger">
                <TriangleAlert size={16} className="mt-0.5 shrink-0" /> {t("imp.importBlocked", { count: result.errorCount })}
              </p>
              <div className="mt-3 max-h-72 overflow-auto rounded-2xl border border-border">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-muted/70">
                    <tr>
                      <th className="px-3 py-2 text-start font-bold">{t("imp.rowCol")}</th>
                      <th className="px-3 py-2 text-start font-bold">{t("imp.messageCol")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.errors.map((e, i) => (
                      <tr key={i} className="border-t border-border">
                        <td className="px-3 py-2 font-bold tabular-nums">{e.row > 0 ? e.row : "—"}</td>
                        <td className="px-3 py-2">{e.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="mt-4 flex items-start gap-2 text-sm font-semibold text-primary">
              <CheckCircle2 size={16} className="mt-0.5 shrink-0" /> {t("imp.readyToImport", { count: result.validCount })}
            </p>
          )}
          <div className="mt-6 flex flex-wrap gap-2">
            <button type="button" className="btn btn-ghost text-sm" onClick={() => setStep("map")}>
              <ArrowLeft size={15} /> {t("common.back")}
            </button>
            <button type="button" className="btn btn-ghost text-sm" disabled={busy} onClick={runValidate}>
              {t("imp.validateAgain")}
            </button>
            {result.errorCount === 0 && (
              <button type="button" className="btn btn-primary text-sm" disabled={busy} onClick={runImport}>
                <Upload size={15} /> {busy ? t("imp.importing") : t("imp.importBtn", { count: result.validCount })}
              </button>
            )}
          </div>
        </div>
      )}

      {step === "done" && done && (
        <div className="card mx-auto max-w-2xl p-6 text-center sm:p-8">
          <CheckCircle2 size={40} className="mx-auto text-primary" />
          <h2 className="mt-3 text-lg font-extrabold">{t("imp.doneTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("imp.doneSummary", { imported: done.imported, skipped: done.skipped })}
          </p>
          <button type="button" className="btn btn-primary mt-6 text-sm" onClick={() => { setStep("kind"); setFile(null); setResult(null); setDone(null); }}>
            {t("imp.importAnother")}
          </button>
        </div>
      )}

      {/* import history */}
      <div className="card mx-auto mt-8 max-w-3xl p-6 sm:p-8">
        <h2 className="text-lg font-extrabold">{t("imp.logTitle")}</h2>
        {logs.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">{t("imp.noLogs")}</p>
        ) : (
          <ul className="mt-4 space-y-2">
            {logs.map((l) => (
              <li key={l.id} className="rounded-2xl border border-border p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-bold">{l.fileName || l.kind}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("imp.logSummary", { imported: l.importedRows, skipped: l.skippedRows, errors: l.errorCount })}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`badge ${l.status === "SUCCESS" ? "bg-primary-soft text-primary" : "bg-danger-soft text-danger"}`}>
                      {t(l.status === "SUCCESS" ? "imp.stSuccess" : "imp.stFailed")}
                    </span>
                    {l.errorCount > 0 && (
                      <button type="button" className="btn btn-ghost !px-2 !py-1 text-xs"
                        onClick={() => setOpenLog(openLog === l.id ? null : l.id)}>
                        {t("imp.viewErrors")}
                      </button>
                    )}
                  </div>
                </div>
                {openLog === l.id && l.errors.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-border pt-3 text-xs text-muted-foreground">
                    {l.errors.map((e, i) => (
                      <li key={i}>{e.row > 0 ? t("imp.rowCol") + " " + e.row + ": " : ""}{e.message}</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function aliasMatch(header: string, field: string): boolean {
  const h = header.toLowerCase();
  const aliases: Record<string, string[]> = {
    sku: ["code", "item code", "product code"],
    name: ["product", "product name", "item", "item name", "party", "customer", "supplier"],
    barcode: ["bar code", "ean", "upc"],
    category: ["group", "type"],
    unit: ["uom"],
    purchasePrice: ["purchase", "cost", "buy"],
    salePrice: ["sale", "sell", "price", "rate", "mrp"],
    trackStock: ["track", "stock"],
    type: ["kind"],
    phone: ["mobile", "contact", "tel"],
    email: ["e-mail"],
    address: ["addr"],
    city: ["town"],
    creditLimit: ["limit", "udhaar"],
    qty: ["quantity", "qnty", "stock"],
    rate: ["cost", "unit cost", "price"],
  };
  return (aliases[field] ?? []).some((a) => h.includes(a));
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="rounded-2xl bg-muted/60 p-3 text-center">
      <p className={`text-xl font-extrabold tabular-nums ${tone ?? ""}`}>{value}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
