"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Ship, ArrowLeft, ArrowRight, Plus, Trash2, Search, X, Check } from "lucide-react";
import { PageHeader, ErrorNote, Field } from "@/components/ui";
import { api, fmtMoney, fmtQty, fmtDate, fmtDateInput } from "@/lib/format";
import { localizedApiError } from "@/lib/api-errors";
import { useLang } from "@/components/lang-provider";

type Basis = "VALUE" | "QTY" | "WEIGHT";
type HeadKind = "FREIGHT" | "DUTY" | "CLEARING" | "OTHER";
const BASES: Basis[] = ["VALUE", "QTY", "WEIGHT"];
const HEADS: HeadKind[] = ["FREIGHT", "DUTY", "CLEARING", "OTHER"];

type DocPick = { id: string; docNo: string; docType: string; date: number; grandTotal: string; partyName: string | null };
type ProductPick = { id: string; name: string; sku: string; unit: string };
type HeadRow = { head: HeadKind; label: string; amount: string };
type PreviewLine = {
  productId: string; productName: string; sku: string | null; unit: string | null;
  qtyMilli: string; valuePaisa: string; weightScaled: string; basisValue: string; allocatedPaisa: string;
};

function basisLabel(basis: Basis, line: PreviewLine, gramsWord: string): string {
  if (basis === "VALUE") return fmtMoney(line.valuePaisa);
  if (basis === "QTY") return fmtQty(line.qtyMilli, line.unit ?? "");
  // weightScaled = qtyMilli × grams → grams with milli precision
  const g = Number(BigInt(line.weightScaled)) / 1000;
  return `${g.toLocaleString("en-PK", { maximumFractionDigits: 3 })} ${gramsWord}`;
}

export default function LandedCostNewPage() {
  const { t } = useLang();
  const router = useRouter();
  const [step, setStep] = useState(1);
  const [date, setDate] = useState(fmtDateInput(new Date()));
  const [mode, setMode] = useState<"doc" | "explicit">("doc");

  // step 1 — doc picker
  const [docType, setDocType] = useState("BILL");
  const [docQ, setDocQ] = useState("");
  const [docResults, setDocResults] = useState<DocPick[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocPick | null>(null);
  // step 1 — explicit products
  const [prodQ, setProdQ] = useState("");
  const [prodResults, setProdResults] = useState<ProductPick[]>([]);
  const [chosen, setChosen] = useState<ProductPick[]>([]);

  // step 2 — costs
  const [basis, setBasis] = useState<Basis>("VALUE");
  const [heads, setHeads] = useState<HeadRow[]>([{ head: "FREIGHT", label: "", amount: "" }]);

  // step 3 — preview + post
  const [preview, setPreview] = useState<{ lines: PreviewLine[]; totalPaisa: string } | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);
  const idemKey = useRef<string>(crypto.randomUUID());

  // doc search (debounced)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clear stale results when search is inactive
    if (mode !== "doc" || selectedDoc) { setDocResults([]); return; }
    const h = setTimeout(async () => {
      try {
        const d = await api<{ data: DocPick[] }>(
          `/api/purchases?docType=${docType}&q=${encodeURIComponent(docQ)}&perPage=8`
        );
        setDocResults(d.data);
      } catch { setDocResults([]); }
    }, 250);
    return () => clearTimeout(h);
  }, [mode, docType, docQ, selectedDoc]);

  // product search (debounced)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional: clear stale results when search is inactive
    if (mode !== "explicit") { setProdResults([]); return; }
    const h = setTimeout(async () => {
      try {
        const d = await api<{ data: ProductPick[] }>(
          `/api/products?q=${encodeURIComponent(prodQ)}&perPage=8`
        );
        setProdResults(d.data.filter((p) => !chosen.some((c) => c.id === p.id)));
      } catch { setProdResults([]); }
    }, 250);
    return () => clearTimeout(h);
  }, [mode, prodQ, chosen]);

  const headsTotal = useMemo(() => {
    let s = 0;
    for (const h of heads) {
      const v = parseFloat(h.amount);
      if (Number.isFinite(v) && v > 0) s += v;
    }
    return s;
  }, [heads]);

  function validHeads(): boolean {
    return heads.some((h) => { const v = parseFloat(h.amount); return Number.isFinite(v) && v > 0; });
  }

  function canNext1(): boolean {
    return mode === "doc" ? !!selectedDoc : chosen.length > 0;
  }

  async function goPreview() {
    setError(null);
    setPreviewLoading(true);
    try {
      const d = await api<{ data: { lines: PreviewLine[]; totalPaisa: string } }>("/api/landed-cost/preview", {
        method: "POST",
        body: JSON.stringify({
          purchaseDocId: mode === "doc" ? selectedDoc!.id : undefined,
          basis,
          heads: heads
            .filter((h) => { const v = parseFloat(h.amount); return Number.isFinite(v) && v > 0; })
            .map((h) => ({ head: h.head, label: h.label, amount: parseFloat(h.amount).toFixed(2) })),
          lines: mode === "explicit" ? chosen.map((c) => ({ productId: c.id })) : [],
        }),
      });
      setPreview(d.data);
      setStep(3);
    } catch (e) {
      setError(localizedApiError(e instanceof Error ? e : null, t));
    } finally { setPreviewLoading(false); }
  }

  async function post() {
    if (posting || !preview) return;
    setPosting(true);
    setError(null);
    try {
      const d = await api<{ data: { id: string } }>("/api/landed-cost", {
        method: "POST",
        body: JSON.stringify({
          date,
          purchaseDocId: mode === "doc" ? selectedDoc!.id : undefined,
          basis,
          heads: heads
            .filter((h) => { const v = parseFloat(h.amount); return Number.isFinite(v) && v > 0; })
            .map((h) => ({ head: h.head, label: h.label, amount: parseFloat(h.amount).toFixed(2) })),
          lines: mode === "explicit" ? chosen.map((c) => ({ productId: c.id })) : [],
          idempotencyKey: idemKey.current,
        }),
      });
      router.push(`/purchases/landed-cost/${d.data.id}`);
    } catch (e) {
      setError(localizedApiError(e instanceof Error ? e : null, t));
      setPosting(false);
    }
  }

  const steps = [t("landedCost.step1"), t("landedCost.step2"), t("landedCost.step3")];

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title={t("landedCost.newSheet")}
        subtitle={t("landedCost.wizardHint")}
        icon={<Ship size={20} />}
        actions={
          <Link href="/purchases/landed-cost" className="btn btn-ghost text-sm">
            <ArrowLeft size={16} /> {t("common.back")}
          </Link>
        }
      />

      {/* stepper */}
      <div className="mb-6 flex items-center gap-2">
        {steps.map((s, i) => (
          <div key={s} className="flex flex-1 items-center gap-2">
            <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-extrabold ${
              step > i + 1 ? "bg-primary text-primary-foreground" : step === i + 1 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            }`}>
              {step > i + 1 ? <Check size={14} /> : i + 1}
            </span>
            <span className={`text-xs font-bold ${step === i + 1 ? "text-foreground" : "text-muted-foreground"}`}>{s}</span>
            {i < steps.length - 1 && <span className="mx-1 h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>

      <ErrorNote message={error} />

      {step === 1 && (
        <div className="card space-y-5 p-5">
          <Field label={t("landedCost.date")}>
            <input type="date" className="field" value={date} max={fmtDateInput(new Date())}
              onChange={(e) => setDate(e.target.value)} />
          </Field>

          <div>
            <p className="mb-2 text-sm font-bold">{t("landedCost.source")}</p>
            <div className="mb-3 flex gap-1 rounded-xl bg-muted p-1">
              {(["doc", "explicit"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)}
                  className={`flex-1 rounded-lg px-3 py-2 text-xs font-bold transition ${mode === m ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                  {t(`landedCost.mode_${m}`)}
                </button>
              ))}
            </div>

            {mode === "doc" ? (
              selectedDoc ? (
                <div className="flex items-center justify-between rounded-xl bg-muted/60 px-3 py-2.5">
                  <div>
                    <p className="text-sm font-bold">{selectedDoc.docType} {selectedDoc.docNo}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtDate(selectedDoc.date)} · {selectedDoc.partyName ?? "—"} · {fmtMoney(selectedDoc.grandTotal)}
                    </p>
                  </div>
                  <button className="btn btn-ghost !p-2" onClick={() => setSelectedDoc(null)} aria-label={t("common.remove")}>
                    <X size={15} />
                  </button>
                </div>
              ) : (
                <div>
                  <div className="mb-2 flex gap-1">
                    {[["BILL", t("docs.typeBills")], ["GRN", t("docs.typeGrns")]].map(([v, l]) => (
                      <button key={v} onClick={() => setDocType(v)}
                        className={`rounded-lg px-3 py-1.5 text-xs font-bold ${docType === v ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                        {l}
                      </button>
                    ))}
                  </div>
                  <div className="relative">
                    <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                    <input className="field !ps-10" placeholder={t("landedCost.searchBill")}
                      value={docQ} onChange={(e) => setDocQ(e.target.value)} />
                  </div>
                  {docResults.length > 0 && (
                    <ul className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border">
                      {docResults.map((d) => (
                        <li key={d.id}>
                          <button className="flex w-full items-center justify-between px-3 py-2.5 text-start hover:bg-muted/60"
                            onClick={() => setSelectedDoc(d)}>
                            <span>
                              <span className="block text-sm font-bold">{d.docType} {d.docNo}</span>
                              <span className="block text-xs text-muted-foreground">
                                {fmtDate(d.date)} · {d.partyName ?? "—"}
                              </span>
                            </span>
                            <span className="text-sm font-bold">{fmtMoney(d.grandTotal)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )
            ) : (
              <div>
                {chosen.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {chosen.map((c) => (
                      <span key={c.id} className="flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1 text-xs font-bold">
                        {c.name}
                        <button onClick={() => setChosen((cs) => cs.filter((x) => x.id !== c.id))} aria-label={t("common.remove")}>
                          <X size={13} />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="relative">
                  <Search size={16} className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
                  <input className="field !ps-10" placeholder={t("landedCost.searchProduct")}
                    value={prodQ} onChange={(e) => setProdQ(e.target.value)} />
                </div>
                {prodResults.length > 0 && (
                  <ul className="mt-2 max-h-64 overflow-y-auto rounded-xl border border-border">
                    {prodResults.map((p) => (
                      <li key={p.id}>
                        <button className="flex w-full items-center justify-between px-3 py-2.5 text-start hover:bg-muted/60"
                          onClick={() => { setChosen((cs) => [...cs, p]); setProdQ(""); }}>
                          <span>
                            <span className="block text-sm font-bold">{p.name}</span>
                            <span className="block text-xs text-muted-foreground">{p.sku} · {p.unit}</span>
                          </span>
                          <Plus size={16} className="text-primary" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-2 text-xs text-muted-foreground">{t("landedCost.explicitHint")}</p>
              </div>
            )}
          </div>

          <div className="flex justify-end">
            <button className="btn btn-primary" disabled={!canNext1()} onClick={() => setStep(2)}>
              {t("common.next")} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="card space-y-5 p-5">
          <div>
            <p className="mb-2 text-sm font-bold">{t("landedCost.basis")}</p>
            <div className="grid grid-cols-3 gap-2">
              {BASES.map((b) => (
                <button key={b} onClick={() => setBasis(b)}
                  className={`rounded-xl border px-3 py-3 text-start transition ${
                    basis === b ? "border-primary bg-primary/5" : "border-border hover:border-muted-foreground"
                  }`}>
                  <span className="block text-sm font-extrabold">{t(`landedCost.basis_${b}`)}</span>
                  <span className="block text-[11px] text-muted-foreground">{t(`landedCost.basis_${b}_hint`)}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-bold">{t("landedCost.heads")}</p>
              <span className="text-sm font-extrabold">{t("landedCost.totalHeads", { total: headsTotal.toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}</span>
            </div>
            <div className="space-y-2">
              {heads.map((h, i) => (
                <div key={i} className="flex flex-wrap items-end gap-2">
                  <Field label={t("landedCost.head")}>
                    <select className="field !w-auto" value={h.head}
                      onChange={(e) => setHeads((hs) => hs.map((x, j) => j === i ? { ...x, head: e.target.value as HeadKind } : x))}>
                      {HEADS.map((k) => <option key={k} value={k}>{t(`landedCost.head_${k}`)}</option>)}
                    </select>
                  </Field>
                  <Field label={t("landedCost.headLabel")}>
                    <input className="field !w-36" value={h.label} maxLength={60}
                      placeholder={t("landedCost.headLabelPh")}
                      onChange={(e) => setHeads((hs) => hs.map((x, j) => j === i ? { ...x, label: e.target.value } : x))} />
                  </Field>
                  <Field label={t("landedCost.amount")}>
                    <input className="field !w-32 text-end" inputMode="decimal" placeholder="0.00" value={h.amount}
                      onChange={(e) => setHeads((hs) => hs.map((x, j) => j === i ? { ...x, amount: e.target.value.replace(/[^0-9.]/g, "") } : x))} />
                  </Field>
                  <button className="btn btn-ghost !p-2 text-muted-foreground hover:text-danger"
                    onClick={() => setHeads((hs) => hs.filter((_, j) => j !== i))}
                    disabled={heads.length === 1} aria-label={t("common.remove")}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))}
            </div>
            {heads.length < 20 && (
              <button className="btn btn-ghost mt-2 text-xs font-bold text-primary"
                onClick={() => setHeads((hs) => [...hs, { head: "OTHER", label: "", amount: "" }])}>
                <Plus size={14} /> {t("landedCost.addHead")}
              </button>
            )}
          </div>

          <div className="flex justify-between">
            <button className="btn btn-ghost" onClick={() => setStep(1)}>
              <ArrowLeft size={16} /> {t("common.back")}
            </button>
            <button className="btn btn-primary" disabled={!validHeads() || previewLoading} onClick={goPreview}>
              {previewLoading ? t("common.loading") : t("landedCost.preview")} <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="card space-y-5 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-sm font-bold">{t("landedCost.previewTitle")}</p>
              <p className="text-xs text-muted-foreground">
                {t(`landedCost.basis_${basis}`)} · {t("landedCost.totalHeads", { total: (Number(BigInt(preview.totalPaisa)) / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) })}
              </p>
            </div>
            <button className="btn btn-ghost text-xs" onClick={() => setStep(2)}>{t("landedCost.editCosts")}</button>
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="table">
              <thead>
                <tr>
                  <th>{t("landedCost.product")}</th>
                  <th className="num">{t("landedCost.qtyOnHand")}</th>
                  <th className="num">{t("landedCost.basisValue")}</th>
                  <th className="num">{t("landedCost.allocated")}</th>
                </tr>
              </thead>
              <tbody>
                {preview.lines.map((l) => (
                  <tr key={l.productId}>
                    <td>
                      <span className="font-semibold">{l.productName}</span>
                      <span className="block text-[11px] text-muted-foreground">{l.sku ?? ""} · {l.unit ?? ""}</span>
                    </td>
                    <td className="num">{fmtQty(l.qtyMilli, l.unit ?? "")}</td>
                    <td className="num">{basisLabel(basis, l, t("landedCost.grams"))}</td>
                    <td className="num font-extrabold">{fmtMoney(l.allocatedPaisa)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-extrabold">
                  <td colSpan={3}>{t("common.total")}</td>
                  <td className="num">{fmtMoney(preview.totalPaisa)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t("landedCost.previewHint")}</p>

          <div className="flex justify-between">
            <button className="btn btn-ghost" onClick={() => setStep(2)}>
              <ArrowLeft size={16} /> {t("common.back")}
            </button>
            <button className="btn btn-primary" disabled={posting} onClick={post}>
              {posting ? t("common.saving") : t("landedCost.postSheet")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
