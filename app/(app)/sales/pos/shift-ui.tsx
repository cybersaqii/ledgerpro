"use client";

// Module 14 (14.1/14.4): POS shift UI — the strip above the counter with the
// open-shift state, cash in/out, drawer-open audit event, close-shift with a
// live Z-report, and the per-terminal manager (print settings included).

import { useEffect, useRef, useState } from "react";
import {
  X, Plus, Printer, Settings2, LogOut, Wallet, Clock3,
  ArrowDownToLine, ArrowUpFromLine, ReceiptText,
} from "lucide-react";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { ErrorNote, Field, Switch } from "@/components/ui";

export interface ShiftSession {
  id: string;
  terminalId: string;
  terminalName: string;
  cashAccountId: string;
  status: string;
  openedAt: string;
  closedAt: string | null;
  openingCashPaisa: string;
  countedCashPaisa: string | null;
  expectedCashPaisa: string | null;
  variancePaisa: string | null;
  cashSalesPaisa: string;
  cardSalesPaisa: string;
  totalSalesPaisa: string;
  totalDiscountPaisa: string;
  totalTaxPaisa: string;
  salesCount: number;
  cashRefundsPaisa: string;
  returnsCount: number;
  returnsTotalPaisa: string;
  cashInPaisa: string;
  cashOutPaisa: string;
}

export interface PosTerminalDto {
  id: string;
  name: string;
  cashAccountId: string;
  cashAccountName: string | null;
  receiptHeader: string | null;
  receiptFooter: string | null;
  receiptCopies: number;
  autoPrint: boolean;
  isActive: boolean;
}

interface CloseResult {
  session: ShiftSession;
  countedCashPaisa: string;
  expectedCashPaisa: string;
  variancePaisa: string;
  varianceEntryId: string | null;
  idempotentReplay: boolean;
}

const paisa = (v: string | null | undefined) => { try { return BigInt(v || "0"); } catch { return 0n; }; };
const toRs = (v: string) => v.replace(/[^0-9.]/g, "");
/** Exact decimal-rupees → paisa (no float): "1500.5" → 150050n. Preview math only; the server is authoritative. */
const rsToPaisa = (v: string): bigint => {
  const [r = "", p = ""] = v.split(".");
  return BigInt(`${r || "0"}${(p + "00").slice(0, 2)}`);
};

function Modal({ label, onClose, children, wide }: { label: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center overflow-y-auto bg-black/50 p-4 print:hidden" onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-label={label}
        className={`w-full ${wide ? "max-w-lg" : "max-w-sm"} rounded-2xl bg-card p-6 shadow-xl`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

function SummaryRow({ label, value, bold, tone }: { label: string; value: string; bold?: boolean; tone?: "danger" | "success" }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`tabular-nums ${bold ? "text-base font-extrabold" : "text-sm font-bold"} ${tone === "danger" ? "text-red-500" : tone === "success" ? "text-emerald-500" : ""}`}>
        {value}
      </span>
    </div>
  );
}

/** Live Z-report rendered 80mm-thermal style; honours the terminal's print settings. */
export function ZReport({ result, terminal, companyName }: { result: CloseResult; terminal: PosTerminalDto | null; companyName: string }) {
  const { t } = useLang();
  const s = result.session;
  const v = paisa(result.variancePaisa);
  const copies = terminal?.receiptCopies ?? 1;
  return (
    <div className="mx-auto w-[72mm] max-w-full bg-white p-4 text-black shadow-xl print:shadow-none dark:bg-white">
      <div className="text-center">
        {terminal?.receiptHeader ? (
          <p className="whitespace-pre-line text-xs">{terminal.receiptHeader}</p>
        ) : (
          <p className="text-base font-extrabold">{companyName}</p>
        )}
        <p className="mt-1 text-xs font-bold tracking-widest">Z-REPORT</p>
        <p className="text-xs">{s.terminalName} · {t("pos.shift.closedAt", { time: s.closedAt ? new Date(s.closedAt).toLocaleString("en-PK", { day: "2-digit", month: "short", hour: "numeric", minute: "2-digit" }) : "" })}</p>
        <p className="text-xs">{t("pos.shift.openedAt", { time: new Date(s.openedAt).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" }) })}</p>
      </div>
      <hr className="my-2 border-dashed border-black/40" />
      <SummaryRow label={t("pos.shift.sales")} value={`${s.salesCount} × ${fmtMoney(paisa(s.totalSalesPaisa))}`} />
      <SummaryRow label={t("pos.shift.discounts")} value={fmtMoney(paisa(s.totalDiscountPaisa))} />
      <SummaryRow label={t("pos.shift.tax")} value={fmtMoney(paisa(s.totalTaxPaisa))} />
      <SummaryRow label={t("pos.shift.returns")} value={`${s.returnsCount} × ${fmtMoney(paisa(s.returnsTotalPaisa))}`} />
      <SummaryRow label={t("pos.shift.cashSales")} value={fmtMoney(paisa(s.cashSalesPaisa))} />
      <SummaryRow label={t("pos.shift.cardSales")} value={fmtMoney(paisa(s.cardSalesPaisa))} />
      <SummaryRow label={t("pos.shift.refunds")} value={fmtMoney(paisa(s.cashRefundsPaisa))} />
      <hr className="my-2 border-dashed border-black/40" />
      <SummaryRow label={t("pos.shift.opening")} value={fmtMoney(paisa(s.openingCashPaisa))} />
      <SummaryRow label={t("pos.shift.cashInOut")} value={`${fmtMoney(paisa(s.cashInPaisa))} / ${fmtMoney(paisa(s.cashOutPaisa))}`} />
      <SummaryRow label={t("pos.shift.expectedCash")} value={fmtMoney(paisa(result.expectedCashPaisa))} bold />
      <SummaryRow label={t("pos.shift.countedCash")} value={fmtMoney(paisa(result.countedCashPaisa))} bold />
      <SummaryRow
        label={t("pos.shift.variance")}
        value={v === 0n ? t("pos.shift.exact") : `${v < 0n ? t("pos.shift.short") : t("pos.shift.over")} ${fmtMoney(v < 0n ? -v : v)}`}
        bold tone={v === 0n ? "success" : v < 0n ? "danger" : "success"}
      />
      {terminal?.receiptFooter && <p className="mt-2 whitespace-pre-line text-center text-xs">{terminal.receiptFooter}</p>}
      <style>{`
        @media print {
          @page { margin: 4mm; }
          body { background: white !important; }
        }
      `}</style>
      <div className="mt-4 flex gap-2 print:hidden">
        <button
          className="btn btn-primary w-full !py-2.5 text-sm"
          onClick={() => { for (let i = 0; i < copies; i++) window.print(); }}
        >
          <Printer size={15} /> {t("pos.shift.printReport")}{copies > 1 ? ` ×${copies}` : ""}
        </button>
      </div>
    </div>
  );
}

/** Open-shift dialog: pick a terminal + starting float. */
function OpenShiftDialog({ terminals, onClose, onOpened }: {
  terminals: PosTerminalDto[]; onClose: () => void; onOpened: (s: ShiftSession) => void;
}) {
  const { t } = useLang();
  const active = terminals.filter((x) => x.isActive);
  const [terminalId, setTerminalId] = useState(active[0]?.id ?? "");
  const [cash, setCash] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!terminalId) { setErr(t("pos.shift.selectTerminal")); return; }
    setBusy(true); setErr(null);
    try {
      const d = await api<{ data: { session: ShiftSession } }>("/api/pos/sessions", {
        method: "POST",
        body: JSON.stringify({ terminalId, openingCash: cash || "0" }),
      });
      onOpened(d.data.session);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("pos.shift.errOpen"));
    } finally { setBusy(false); }
  }

  return (
    <Modal label={t("pos.shift.openTitle")} onClose={onClose}>
      <h3 className="text-lg font-extrabold">{t("pos.shift.openTitle")}</h3>
      <ErrorNote message={err} />
      <div className="mt-4 space-y-3">
        <Field label={t("pos.shift.terminal")} required>
          {active.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("pos.shift.noTerminal")}</p>
          ) : (
            <select className="field" value={terminalId} onChange={(e) => setTerminalId(e.target.value)}>
              {active.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          )}
        </Field>
        <Field label={t("pos.shift.openingCash")}>
          <input className="field" inputMode="decimal" placeholder="0.00"
            value={cash} onChange={(e) => setCash(toRs(e.target.value))} />
        </Field>
        <div className="flex gap-2 pt-1">
          <button className="btn btn-ghost flex-1" onClick={onClose}>{t("pos.cancel")}</button>
          <button className="btn btn-primary flex-1" disabled={busy || active.length === 0} onClick={submit}>
            {busy ? t("pos.saving") : t("pos.shift.openNow")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Cash in/out dialog: drawer-only movement, no GL posting. */
function CashMoveDialog({ session, kind, onClose, onDone }: {
  session: ShiftSession; kind: "IN" | "OUT"; onClose: () => void; onDone: (s: ShiftSession) => void;
}) {
  const { t } = useLang();
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    if (!amount || Number(amount) <= 0) { setErr(t("pos.shift.errAmount")); return; }
    setBusy(true); setErr(null);
    try {
      await api(`/api/pos/sessions/${session.id}/cash`, {
        method: "POST",
        body: JSON.stringify({ kind, amount, note: note.trim() || undefined }),
      });
      const d = await api<{ data: { session: ShiftSession } }>(`/api/pos/sessions/${session.id}`);
      onDone(d.data.session);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("pos.shift.errCash"));
    } finally { setBusy(false); }
  }

  return (
    <Modal label={kind === "IN" ? t("pos.shift.cashInTitle") : t("pos.shift.cashOutTitle")} onClose={onClose}>
      <h3 className="text-lg font-extrabold">{kind === "IN" ? t("pos.shift.cashInTitle") : t("pos.shift.cashOutTitle")}</h3>
      <ErrorNote message={err} />
      <div className="mt-4 space-y-3">
        <Field label={t("pos.shift.amount")} required>
          <input className="field text-lg font-bold" inputMode="decimal" placeholder="0.00" autoFocus
            value={amount} onChange={(e) => setAmount(toRs(e.target.value))} />
        </Field>
        <Field label={t("pos.shift.note")}>
          <input className="field" placeholder={t("pos.shift.notePh")}
            value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <div className="flex gap-2 pt-1">
          <button className="btn btn-ghost flex-1" onClick={onClose}>{t("pos.cancel")}</button>
          <button className={`btn flex-1 text-white ${kind === "IN" ? "bg-emerald-600 hover:bg-emerald-700" : "bg-amber-600 hover:bg-amber-700"}`}
            disabled={busy} onClick={submit}>
            {busy ? t("pos.saving") : kind === "IN" ? t("pos.shift.add") : t("pos.shift.takeOut")}
          </button>
        </div>
      </div>
    </Modal>
  );
}

/** Close-shift dialog: live summary, counted cash, variance preview, then the Z-report. */
function CloseShiftDialog({ session, terminals, companyName, onClose, onClosed }: {
  session: ShiftSession; terminals: PosTerminalDto[]; companyName: string;
  onClose: () => void; onClosed: (r: CloseResult) => void;
}) {
  const { t } = useLang();
  const [live, setLive] = useState<ShiftSession | null>(null);
  const [expected, setExpected] = useState("0");
  const [counted, setCounted] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<CloseResult | null>(null);

  useEffect(() => {
    let dead = false;
    api<{ data: { session: ShiftSession; summary: Record<string, string | number> } }>(`/api/pos/sessions/${session.id}`)
      .then((d) => {
        if (dead) return;
        setLive(d.data.session);
        const sm = d.data.summary as Record<string, string>;
        setExpected(sm.expectedCashPaisa ?? "0");
      })
      .catch((e) => { if (!dead) setErr(e instanceof Error ? e.message : t("pos.shift.errClose")); });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id]);

  const s = live ?? session;
  const variance = counted === "" ? null : rsToPaisa(counted) - paisa(expected);

  async function submit() {
    if (counted === "") { setErr(t("pos.shift.errCounted")); return; }
    if (!window.confirm(t("pos.shift.closeConfirm"))) return;
    setBusy(true); setErr(null);
    try {
      const d = await api<{ data: CloseResult }>(`/api/pos/sessions/${session.id}/close`, {
        method: "POST",
        body: JSON.stringify({ countedCash: counted }),
      });
      setResult(d.data);
      onClosed(d.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("pos.shift.errClose"));
    } finally { setBusy(false); }
  }

  if (result) {
    const terminal = terminals.find((x) => x.id === result.session.terminalId) ?? null;
    return (
      <Modal label={t("pos.shift.closeTitle")} onClose={onClose} wide>
        <ZReport result={result} terminal={terminal} companyName={companyName} />
        <button className="btn btn-ghost mt-3 w-full" onClick={onClose}>{t("pos.newBill")}</button>
      </Modal>
    );
  }

  return (
    <Modal label={t("pos.shift.closeTitle")} onClose={onClose} wide>
      <h3 className="text-lg font-extrabold">{t("pos.shift.closeTitle")}</h3>
      <p className="mt-0.5 text-xs text-muted-foreground">{s.terminalName}</p>
      <ErrorNote message={err} />
      {!live && !err && <p className="mt-4 text-sm text-muted-foreground">{t("pos.saving")}</p>}
      {live && (
        <div className="mt-3 divide-y divide-border rounded-xl border border-border px-4">
          <SummaryRow label={t("pos.shift.sales")} value={`${s.salesCount} × ${fmtMoney(paisa(s.totalSalesPaisa))}`} />
          <SummaryRow label={t("pos.shift.discounts")} value={fmtMoney(paisa(s.totalDiscountPaisa))} />
          <SummaryRow label={t("pos.shift.returns")} value={`${s.returnsCount} × ${fmtMoney(paisa(s.returnsTotalPaisa))}`} />
          <SummaryRow label={t("pos.shift.cashSales")} value={fmtMoney(paisa(s.cashSalesPaisa))} />
          <SummaryRow label={t("pos.shift.cardSales")} value={fmtMoney(paisa(s.cardSalesPaisa))} />
          <SummaryRow label={t("pos.shift.refunds")} value={fmtMoney(paisa(s.cashRefundsPaisa))} />
          <SummaryRow label={t("pos.shift.opening")} value={fmtMoney(paisa(s.openingCashPaisa))} />
          <SummaryRow label={t("pos.shift.cashInOut")} value={`${fmtMoney(paisa(s.cashInPaisa))} / ${fmtMoney(paisa(s.cashOutPaisa))}`} />
          <SummaryRow label={t("pos.shift.expectedCash")} value={fmtMoney(paisa(expected))} bold />
        </div>
      )}
      <Field label={t("pos.shift.countedCash")} required hint={t("pos.shift.countedCashHint")}>
        <input className="field text-lg font-bold" inputMode="decimal" placeholder="0.00"
          value={counted} onChange={(e) => setCounted(toRs(e.target.value))} />
      </Field>
      {variance !== null && (
        <div className={`mt-2 flex items-center justify-between rounded-xl px-4 py-3 ${variance === 0n ? "bg-emerald-500/15" : "bg-amber-500/15"}`}>
          <span className="text-sm font-bold">{t("pos.shift.variance")}</span>
          <span className={`text-xl font-extrabold ${variance === 0n ? "text-emerald-600" : variance < 0n ? "text-red-500" : "text-amber-600"}`}>
            {variance === 0n ? t("pos.shift.exact")
              : `${variance < 0n ? t("pos.shift.short") : t("pos.shift.over")} ${fmtMoney(variance < 0n ? -variance : variance)}`}
          </span>
        </div>
      )}
      <div className="mt-4 flex gap-2">
        <button className="btn btn-ghost flex-1" onClick={onClose}>{t("pos.cancel")}</button>
        <button className="btn btn-primary flex-1" disabled={busy || !live} onClick={submit}>
          {busy ? t("pos.saving") : t("pos.shift.close")}
        </button>
      </div>
    </Modal>
  );
}

/** Terminal manager: create / edit / deactivate, incl. per-terminal print settings. */
function TerminalManager({ terminals, banks, onClose, onChanged }: {
  terminals: PosTerminalDto[]; banks: { id: string; name: string; kind: string }[];
  onClose: () => void; onChanged: (ts: PosTerminalDto[]) => void;
}) {
  const { t } = useLang();
  const [editing, setEditing] = useState<PosTerminalDto | null>(null);
  const [name, setName] = useState("");
  const [cashAccountId, setCashAccountId] = useState("");
  const [header, setHeader] = useState("");
  const [footer, setFooter] = useState("");
  const [copies, setCopies] = useState("1");
  const [autoPrint, setAutoPrint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const cashBanks = banks.filter((b) => b.kind === "CASH");

  function startNew() {
    setEditing(null);
    setName(""); setCashAccountId(cashBanks[0]?.id ?? "");
    setHeader(""); setFooter(""); setCopies("1"); setAutoPrint(false);
    setErr(null);
  }
  function startEdit(x: PosTerminalDto) {
    setEditing(x);
    setName(x.name); setCashAccountId(x.cashAccountId);
    setHeader(x.receiptHeader ?? ""); setFooter(x.receiptFooter ?? "");
    setCopies(String(x.receiptCopies)); setAutoPrint(x.autoPrint);
    setErr(null);
  }

  async function save() {
    if (!name.trim()) { setErr(t("pos.shift.errTerminal")); return; }
    if (!cashAccountId) { setErr(t("pos.shift.errDrawerAccount")); return; }
    setBusy(true); setErr(null);
    try {
      const body = {
        name: name.trim(), cashAccountId,
        receiptHeader: header.trim() || null, receiptFooter: footer.trim() || null,
        receiptCopies: Math.min(Math.max(parseInt(copies, 10) || 1, 1), 5),
        autoPrint,
      };
      if (editing) {
        await api(`/api/pos/terminals/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) });
      } else {
        await api("/api/pos/terminals", { method: "POST", body: JSON.stringify(body) });
      }
      const d = await api<{ data: PosTerminalDto[] }>("/api/pos/terminals");
      onChanged(d.data);
      startNew();
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("pos.shift.errOpen"));
    } finally { setBusy(false); }
  }

  async function deactivate(x: PosTerminalDto) {
    if (!window.confirm(t("pos.shift.deactivateConfirm"))) return;
    try {
      await api(`/api/pos/terminals/${x.id}`, { method: "DELETE" });
      const d = await api<{ data: PosTerminalDto[] }>("/api/pos/terminals");
      onChanged(d.data);
    } catch (e) {
      setErr(e instanceof Error ? e.message : t("pos.shift.errOpen"));
    }
  }

  return (
    <Modal label={t("pos.shift.manageTerminals")} onClose={onClose} wide>
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-extrabold">{t("pos.shift.terminals")}</h3>
        <button className="btn btn-ghost !p-2" onClick={onClose} aria-label={t("pos.cancel")}><X size={18} /></button>
      </div>
      <ErrorNote message={err} />
      <ul className="mt-3 max-h-48 space-y-2 overflow-y-auto">
        {terminals.map((x) => (
          <li key={x.id} className="flex items-center justify-between gap-2 rounded-xl bg-muted/60 px-4 py-2.5">
            <div className="min-w-0">
              <p className="truncate text-sm font-bold">{x.name}</p>
              <p className="text-xs text-muted-foreground">{x.cashAccountName ?? ""} · {x.isActive ? t("pos.shift.active") : t("pos.shift.inactive")}</p>
            </div>
            <div className="flex shrink-0 gap-1">
              <button className="btn btn-ghost !px-3 !py-1.5 text-xs" onClick={() => startEdit(x)}>{t("pos.shift.editTerminal")}</button>
              {x.isActive && (
                <button className="btn btn-ghost !px-3 !py-1.5 text-xs text-red-500" onClick={() => deactivate(x)}>{t("pos.shift.deactivate")}</button>
              )}
            </div>
          </li>
        ))}
        {terminals.length === 0 && <p className="text-sm text-muted-foreground">{t("pos.shift.noTerminal")}</p>}
      </ul>
      <div className="mt-4 space-y-3 border-t border-border pt-4">
        <p className="text-sm font-extrabold">{editing ? t("pos.shift.editTerminal") : t("pos.shift.newTerminal")}</p>
        <Field label={t("pos.shift.terminalName")} required>
          <input className="field" placeholder={t("pos.shift.terminalNamePh")} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t("pos.shift.drawerAccount")} required>
          <select className="field" value={cashAccountId} onChange={(e) => setCashAccountId(e.target.value)}>
            <option value="">{t("pos.accountPh")}</option>
            {cashBanks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t("pos.shift.receiptHeader")}>
            <textarea className="field" rows={2} placeholder={t("pos.shift.receiptHeaderPh")} value={header} onChange={(e) => setHeader(e.target.value)} />
          </Field>
          <Field label={t("pos.shift.receiptFooter")}>
            <textarea className="field" rows={2} placeholder={t("pos.shift.receiptFooterPh")} value={footer} onChange={(e) => setFooter(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-4">
          <Field label={t("pos.shift.copies")}>
            <input className="field !w-20" inputMode="numeric" value={copies} onChange={(e) => setCopies(e.target.value.replace(/[^0-9]/g, ""))} />
          </Field>
          <div className="pt-6"><Switch checked={autoPrint} onChange={setAutoPrint} label={t("pos.shift.autoPrint")} /></div>
        </div>
        <button className="btn btn-primary w-full" disabled={busy} onClick={save}>
          {busy ? t("pos.saving") : t("pos.shift.save")}
        </button>
      </div>
    </Modal>
  );
}

/** The shift strip above the counter. Owns terminals + the open session. */
export function ShiftBar({ session, onSession, banks }: {
  session: ShiftSession | null;
  /** Second arg: the shift terminal's auto-print receipt flag. */
  onSession: (s: ShiftSession | null, autoPrint?: boolean) => void;
  banks: { id: string; name: string; kind: string }[];
}) {
  const { t } = useLang();
  const [terminals, setTerminals] = useState<PosTerminalDto[]>([]);
  const terminalsRef = useRef<PosTerminalDto[]>([]);
  const [companyName, setCompanyName] = useState("");
  const [dlg, setDlg] = useState<"open" | "in" | "out" | "close" | "terminals" | null>(null);
  const [drawerBusy, setDrawerBusy] = useState(false);

  function setTerminalsBoth(ts: PosTerminalDto[]) { terminalsRef.current = ts; setTerminals(ts); }
  function emitSession(s: ShiftSession | null) {
    const term = s ? terminalsRef.current.find((x) => x.id === s.terminalId) : undefined;
    onSession(s, term?.autoPrint ?? false);
  }

  useEffect(() => {
    let dead = false;
    (async () => {
      try {
        const td = await api<{ data: PosTerminalDto[] }>("/api/pos/terminals");
        if (dead) return;
        setTerminalsBoth(td.data);
        const sd = await api<{ data: ShiftSession[] }>("/api/pos/sessions?status=OPEN&limit=1");
        if (!dead && sd.data.length > 0) emitSession(sd.data[0]);
      } catch { /* offline: counter still works, shifts just don't load */ }
      api<{ data: { name?: string } }>("/api/company").then((d) => { if (!dead) setCompanyName(d.data?.name ?? ""); }).catch(() => {});
    })();
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function openDrawer() {
    if (!session || drawerBusy) return;
    setDrawerBusy(true);
    try {
      await api(`/api/pos/sessions/${session.id}/drawer`, { method: "POST" });
      window.alert(t("pos.shift.drawerLogged"));
    } catch { /* audit event only — never blocks the counter */ } finally { setDrawerBusy(false); }
  }

  function refreshed(s: ShiftSession) { emitSession(s); setDlg(null); }

  return (
    <>
      <div className="card mb-4 flex flex-wrap items-center gap-2 p-3">
        {session ? (
          <>
            <span className="inline-flex items-center gap-2 rounded-full bg-emerald-500/15 px-3 py-1.5 text-xs font-extrabold text-emerald-600">
              <Clock3 size={14} />
              {session.terminalName} · {t("pos.shift.openedAt", { time: new Date(session.openedAt).toLocaleTimeString("en-PK", { hour: "numeric", minute: "2-digit" }) })}
            </span>
            <span className="ms-auto" />
            <button className="btn btn-ghost !px-3 !py-2 text-xs font-bold" onClick={() => setDlg("in")}>
              <ArrowDownToLine size={14} /> {t("pos.shift.cashIn")}
            </button>
            <button className="btn btn-ghost !px-3 !py-2 text-xs font-bold" onClick={() => setDlg("out")}>
              <ArrowUpFromLine size={14} /> {t("pos.shift.cashOut")}
            </button>
            <button className="btn btn-ghost !px-3 !py-2 text-xs font-bold" onClick={openDrawer} disabled={drawerBusy} title={t("pos.shift.khataNote")}>
              <Wallet size={14} /> {t("pos.shift.drawer")}
            </button>
            <button className="btn btn-primary !px-4 !py-2 text-xs font-bold" onClick={() => setDlg("close")}>
              <LogOut size={14} className="rtl:rotate-180" /> {t("pos.shift.close")}
            </button>
          </>
        ) : (
          <>
            <span className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1.5 text-xs font-bold text-muted-foreground">
              <ReceiptText size={14} /> {t("pos.title")}
            </span>
            <span className="ms-auto" />
            <button className="btn btn-primary !px-4 !py-2 text-xs font-bold" onClick={() => setDlg("open")}>
              <Plus size={14} /> {t("pos.shift.open")}
            </button>
          </>
        )}
        <button className="btn btn-ghost !p-2" onClick={() => setDlg("terminals")} aria-label={t("pos.shift.manageTerminals")} title={t("pos.shift.manageTerminals")}>
          <Settings2 size={16} />
        </button>
      </div>

      {dlg === "open" && (
        <OpenShiftDialog terminals={terminals} onClose={() => setDlg(null)} onOpened={refreshed} />
      )}
      {(dlg === "in" || dlg === "out") && session && (
        <CashMoveDialog session={session} kind={dlg === "in" ? "IN" : "OUT"} onClose={() => setDlg(null)} onDone={refreshed} />
      )}
      {dlg === "close" && session && (
        <CloseShiftDialog session={session} terminals={terminals} companyName={companyName}
          onClose={() => setDlg(null)} onClosed={() => { emitSession(null); setDlg(null); }} />
      )}
      {dlg === "terminals" && (
        <TerminalManager terminals={terminals} banks={banks} onClose={() => setDlg(null)} onChanged={setTerminalsBoth} />
      )}
    </>
  );
}
