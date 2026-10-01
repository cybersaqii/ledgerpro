"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, FileSpreadsheet, Plus, Trash2, FolderOpen } from "lucide-react";
import { PageHeader, EmptyState, ErrorNote, Field } from "@/components/ui";
import { Modal } from "@/components/modal";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";
import { api, fmtMoney, fmtDate } from "@/lib/format";
import { StatementDetail } from "@/components/statement-detail";

type Bank = { id: string; name: string; kind: string };
type Statement = {
  id: string; fileName: string; lineCount: number;
  createdAt: number; openingBalance: string; closingBalance: string | null;
};
type PreviewLine = {
  rowNo: number; date: number; description: string; reference: string | null;
  debit: string; credit: string; amount: string; isDuplicate: boolean;
};

/** Display-only CSV split (quoted commas respected); the server does the real parse. */
function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(cell.trim()); cell = ""; }
    else if (ch === "\n") { row.push(cell.trim()); cell = ""; rows.push(row); row = []; }
    else if (ch !== "\r") cell += ch;
  }
  if (cell !== "" || row.length > 0) { row.push(cell.trim()); rows.push(row); }
  return rows.filter((r) => r.some((c) => c !== ""));
}

type Mapping = {
  date: number; description: number; reference: number | null;
  mode: "pair" | "amount"; debit: number | null; credit: number | null; amount: number | null;
};

export default function StatementsPage() {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const { permissions } = usePermissions();
  const canPost = permissions.includes("payments");

  const [banks, setBanks] = useState<Bank[]>([]);
  const [bankId, setBankId] = useState("");
  const [statements, setStatements] = useState<Statement[]>([]);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);
  const [wizard, setWizard] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ data: Bank[] }>("/api/banks")
      .then((d) => {
        setBanks(d.data);
        if (d.data.length > 0) setBankId((cur) => cur || d.data[0].id);
      })
      .catch(() => {});
  }, []);

  const load = useCallback(async () => {
    if (!bankId) return;
    setLoading(true);
    try {
      const d = await api<{ data: Statement[] }>(`/api/bank-accounts/${bankId}/statements`);
      setStatements(d.data);
    } catch { setStatements([]); } finally { setLoading(false); }
  }, [bankId]);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data fetch on bank change
  useEffect(() => { load(); setOpenId(null); }, [load]);

  async function remove(id: string) {
    if (!confirm(m("deleteStmt"))) return;
    try {
      await api(`/api/bank-accounts/${bankId}/statements/${id}`, { method: "DELETE" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errImport"));
    }
  }

  const bank = banks.find((b) => b.id === bankId);

  return (
    <div>
      <PageHeader
        title={m("statementsTitle")}
        subtitle={m("statementsSubtitle")}
        icon={<FileSpreadsheet size={20} />}
        actions={
          <div className="flex gap-2">
            <Link href="/payments" className="btn btn-ghost text-sm">
              <ArrowLeft size={16} className="rtl:rotate-180" /> {t("banks.backToPayments")}
            </Link>
            {canPost && bankId && (
              <button className="btn btn-primary text-sm" onClick={() => setWizard(true)}>
                <Plus size={16} /> {m("importStatement")}
              </button>
            )}
          </div>
        }
      />
      <ErrorNote message={error} />

      {openId ? (
        <div>
          <button className="btn btn-ghost mb-4 text-sm" onClick={() => { setOpenId(null); load(); }}>
            <ArrowLeft size={16} className="rtl:rotate-180" /> {m("backToList")}
          </button>
          <StatementDetail
            bankId={bankId}
            statementId={openId}
            canPost={canPost}
            onDeleted={() => { setOpenId(null); load(); }}
          />
        </div>
      ) : (
        <>
          <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
            <Field label={t("fix4.recon.account")}>
              <select className="field min-w-48" value={bankId} onChange={(e) => setBankId(e.target.value)}>
                {banks.map((b) => (
                  <option key={b.id} value={b.id}>{b.name} ({b.kind})</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="card overflow-hidden">
            {loading ? (
              <div className="space-y-3 p-5">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-12 rounded-xl" />)}</div>
            ) : statements.length === 0 ? (
              <EmptyState title={m("noStatements")} hint={m("csvHint")}
                action={canPost ? <button className="btn btn-primary text-sm" onClick={() => setWizard(true)}><Plus size={16} /> {m("importStatement")}</button> : undefined} />
            ) : (
              <div className="overflow-x-auto">
                <table className="tbl">
                  <thead><tr>
                    <th>{m("fileLabel")}</th><th>{m("colStmtDate")}</th>
                    <th className="num">{m("colStmtDesc")}</th>
                    <th className="text-end">{t("common.edit")}</th>
                  </tr></thead>
                  <tbody>
                    {statements.map((s) => (
                      <tr key={s.id}>
                        <td className="font-bold">{s.fileName}</td>
                        <td className="whitespace-nowrap text-muted-foreground">{fmtDate(s.createdAt)}</td>
                        <td className="num">{m("lineCount", { count: s.lineCount })}</td>
                        <td className="text-end">
                          <div className="flex justify-end gap-1">
                            <button className="btn btn-ghost !px-2.5 !py-1.5 text-xs font-bold text-primary"
                              onClick={() => setOpenId(s.id)}>
                              <FolderOpen size={14} /> {m("openStmt")}
                            </button>
                            {canPost && (
                              <button className="btn btn-ghost !p-2 text-muted-foreground hover:text-danger"
                                title={m("deleteStmt")} onClick={() => remove(s.id)}>
                                <Trash2 size={15} />
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}

      {wizard && (
        <ImportWizard
          bankId={bankId}
          bankName={bank?.name ?? ""}
          onClose={() => setWizard(false)}
          onDone={(id) => { setWizard(false); load(); if (id) setOpenId(id); }}
        />
      )}
    </div>
  );
}

function ImportWizard({
  bankId, bankName, onClose, onDone,
}: {
  bankId: string; bankName: string; onClose: () => void; onDone: (statementId: string | null) => void;
}) {
  const { t } = useLang();
  const m = (k: string, vars?: Record<string, string | number>) => t(`m3banking.${k}`, vars);
  const fileRef = useRef<HTMLInputElement>(null);
  const [step, setStep] = useState<"upload" | "map" | "preview">("upload");
  const [fileName, setFileName] = useState("");
  const [csvText, setCsvText] = useState("");
  const [sample, setSample] = useState<string[][]>([]);
  const [colCount, setColCount] = useState(0);
  const [skipHeader, setSkipHeader] = useState(true);
  const [mapping, setMapping] = useState<Mapping>({
    date: 0, description: 1, reference: null, mode: "pair", debit: 2, credit: 3, amount: null,
  });
  const [preview, setPreview] = useState<PreviewLine[]>([]);
  const [opening, setOpening] = useState("");
  const [closing, setClosing] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function pickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result ?? "");
      const rows = splitCsv(text).slice(0, 6);
      const cols = Math.max(0, ...rows.map((r) => r.length));
      setFileName(f.name);
      setCsvText(text);
      setSample(rows);
      setColCount(cols);
      // Sensible defaults when the file has fewer columns.
      setMapping((mp) => ({
        ...mp,
        date: 0,
        description: cols > 1 ? 1 : 0,
        debit: cols > 2 ? 2 : null,
        credit: cols > 3 ? 3 : null,
        amount: cols <= 2 ? 2 : null,
        mode: cols > 2 ? "pair" : "amount",
      }));
      setStep("map");
    };
    reader.readAsText(f);
  }

  function buildMapping() {
    const base = { date: mapping.date, description: mapping.description, reference: mapping.reference };
    return mapping.mode === "pair"
      ? { ...base, debit: mapping.debit, credit: mapping.credit, amount: null }
      : { ...base, debit: null, credit: null, amount: mapping.amount };
  }

  async function doPreview() {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ data: { lines: PreviewLine[]; lineCount: number } }>(
        `/api/bank-accounts/${bankId}/statements`,
        {
          method: "POST",
          body: JSON.stringify({
            mode: "preview", fileName, csvText, mapping: buildMapping(), skipHeader,
          }),
        }
      );
      setPreview(d.data.lines);
      setStep("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errImport"));
    } finally {
      setBusy(false);
    }
  }

  async function doImport() {
    setBusy(true);
    setError(null);
    try {
      const d = await api<{ data: { statementId: string; lineCount: number; duplicateCount: number } }>(
        `/api/bank-accounts/${bankId}/statements`,
        {
          method: "POST",
          body: JSON.stringify({
            mode: "import", fileName, csvText, mapping: buildMapping(), skipHeader,
            ...(opening ? { openingBalance: opening } : {}),
            ...(closing ? { closingBalance: closing } : {}),
          }),
        }
      );
      onDone(d.data.statementId);
    } catch (err) {
      setError(err instanceof Error ? err.message : m("errImport"));
      setBusy(false);
    }
  }

  const colIdx = Array.from({ length: colCount }, (_, i) => i);
  const colLabel = (i: number) => {
    const v = sample[skipHeader ? 1 : 0]?.[i] ?? sample[0]?.[i] ?? "";
    return `${String.fromCharCode(65 + i)}${v ? ` — ${v.slice(0, 24)}` : ""}`;
  };
  const dupCount = preview.filter((p) => p.isDuplicate).length;

  function mapSelect(
    label: string, value: number | null, onChange: (v: number | null) => void, optional = false
  ) {
    return (
      <Field label={label}>
        <select
          className="field"
          value={value == null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? null : Number(e.target.value))}
        >
          {optional && <option value="">—</option>}
          {colIdx.map((i) => (
            <option key={i} value={i}>{colLabel(i)}</option>
          ))}
        </select>
      </Field>
    );
  }

  return (
    <Modal title={`${m("importStatement")} — ${bankName}`} onClose={onClose} wide>
      <div className="mb-4 flex gap-2 text-xs font-bold">
        {[m("stepUpload"), m("stepMap"), m("stepPreview")].map((s, i) => {
          const active = (step === "upload" && i === 0) || (step === "map" && i === 1) || (step === "preview" && i === 2);
          return (
            <span key={s} className={`rounded-lg px-3 py-1.5 ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
              {s}
            </span>
          );
        })}
      </div>
      <ErrorNote message={error} />

      {step === "upload" && (
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{m("csvHint")}</p>
          <input ref={fileRef} type="file" accept=".csv,text/csv,text/plain" className="hidden" onChange={pickFile} />
          <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>
            <Plus size={16} /> {m("fileLabel")}
          </button>
        </div>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={skipHeader} onChange={(e) => setSkipHeader(e.target.checked)} />
            {m("hasHeader")}
          </label>
          <div className="grid gap-4 sm:grid-cols-2">
            {mapSelect(m("mapDate"), mapping.date, (v) => setMapping((x) => ({ ...x, date: v ?? 0 })))}
            {mapSelect(m("mapDescription"), mapping.description, (v) => setMapping((x) => ({ ...x, description: v ?? 0 })))}
            {mapSelect(m("mapReference"), mapping.reference, (v) => setMapping((x) => ({ ...x, reference: v })), true)}
            <Field label={m("mapMode")}>
              <select className="field" value={mapping.mode}
                onChange={(e) => setMapping((x) => ({ ...x, mode: e.target.value as "pair" | "amount" }))}>
                <option value="pair">{m("modePair")}</option>
                <option value="amount">{m("modeAmount")}</option>
              </select>
            </Field>
            {mapping.mode === "pair" ? (
              <>
                {mapSelect(m("mapDebit"), mapping.debit, (v) => setMapping((x) => ({ ...x, debit: v })), true)}
                {mapSelect(m("mapCredit"), mapping.credit, (v) => setMapping((x) => ({ ...x, credit: v })), true)}
              </>
            ) : (
              mapSelect(m("mapAmount"), mapping.amount, (v) => setMapping((x) => ({ ...x, amount: v })), true)
            )}
          </div>
          {sample.length > 0 && (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="tbl min-w-[560px]">
                <thead><tr>{colIdx.map((i) => <th key={i}>{String.fromCharCode(65 + i)}</th>)}</tr></thead>
                <tbody>
                  {sample.slice(0, 4).map((r, ri) => (
                    <tr key={ri}>{colIdx.map((i) => <td key={i} className="max-w-44 truncate text-xs" dir="auto">{r[i] ?? ""}</td>)}</tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost text-sm" onClick={() => setStep("upload")}>{m("backBtn")}</button>
            <button className="btn btn-primary text-sm" disabled={busy} onClick={doPreview}>
              {busy ? t("common.saving") : m("previewBtn")}
            </button>
          </div>
        </div>
      )}

      {step === "preview" && (
        <div className="space-y-4">
          <p className="text-sm font-bold">
            {m("lineCount", { count: preview.length })}
            {dupCount > 0 && <span className="ms-2 text-warning">{m("dupCount", { count: dupCount })}</span>}
          </p>
          <div className="max-h-72 overflow-auto rounded-xl border border-border">
            <table className="tbl min-w-[560px]">
              <thead><tr>
                <th>{m("colStmtDate")}</th><th>{m("colStmtDesc")}</th>
                <th className="num">{m("colMoneyOut")}</th><th className="num">{m("colMoneyIn")}</th>
                <th>{m("colStatus")}</th>
              </tr></thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={p.rowNo} className={p.isDuplicate ? "opacity-60" : ""}>
                    <td className="whitespace-nowrap text-muted-foreground">{fmtDate(p.date)}</td>
                    <td className="min-w-40"><div className="truncate">{p.description}</div>
                      {p.reference && <div className="text-xs text-muted-foreground" dir="ltr">{p.reference}</div>}</td>
                    <td className="num">{BigInt(p.debit) !== 0n ? fmtMoney(p.debit) : "—"}</td>
                    <td className="num">{BigInt(p.credit) !== 0n ? fmtMoney(p.credit) : "—"}</td>
                    <td>{p.isDuplicate && <span className="badge bg-muted text-muted-foreground">{m("duplicate")}</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={m("openingBal")}>
              <input className="field num" inputMode="decimal" value={opening}
                onChange={(e) => setOpening(e.target.value)} placeholder="0.00" dir="ltr" />
            </Field>
            <Field label={m("closingBal")}>
              <input className="field num" inputMode="decimal" value={closing}
                onChange={(e) => setClosing(e.target.value)} placeholder="0.00" dir="ltr" />
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-ghost text-sm" onClick={() => setStep("map")}>{m("backBtn")}</button>
            <button className="btn btn-primary text-sm" disabled={busy} onClick={doImport}>
              {busy ? m("importing") : m("confirmImport")}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
