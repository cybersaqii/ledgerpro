"use client";

import { useEffect, useState } from "react";
import { Handshake, Plus, X, Wallet, TrendingUp, Eye, EyeOff } from "lucide-react";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { useCan } from "@/components/permissions";
import { api, fmtMoney } from "@/lib/format";

type Partner = {
  id: string;
  name: string;
  phone: string | null;
  profitShareBps: number;
  isActive: boolean;
  capitalBalance: string;
  currentBalance: string;
};

type CashAccount = { id: string; code: string; name: string };

export default function PartnersPage() {
  const { t } = useLang();
  const can = useCan("partners");
  const [partners, setPartners] = useState<Partner[]>([]);
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [showMove, setShowMove] = useState<{ partner: Partner; kind: "contribute" | "draw" } | null>(null);
  const [err, setErr] = useState("");

  const load = () => {
    setLoading(true);
    Promise.all([
      api<{ data: Partner[] }>("/api/partners"),
      api<{ data: CashAccount[] }>("/api/accounts?type=ASSET"),
    ])
      .then(([p, a]) => {
        setPartners(p.data);
        // Cash/bank accounts only (10xx-11xx)
        setCashAccounts(a.data.filter((x) => /^10|^11/.test(x.code)));
      })
      .catch((e) => setErr(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (!can) return <PageHeader title={t("partners.title")} icon={<Handshake size={20} />} />;

  return (
    <div>
      <PageHeader
        title={t("partners.title")}
        icon={<Handshake size={20} />}
        actions={
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
            <Plus size={16} /> {t("partners.addPartner")}
          </button>
        }
      />
      <ErrorNote message={err} />

      {loading ? (
        <p className="text-muted-foreground">{t("common.loading")}</p>
      ) : partners.length === 0 ? (
        <EmptyState
          icon={<Handshake size={32} />}
          title={t("partners.emptyTitle")}
          hint={t("partners.emptyHint")}
          action={
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>
              <Plus size={16} /> {t("partners.addPartner")}
            </button>
          }
        />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {partners.map((p) => (
            <PartnerCard key={p.id} partner={p} onMove={setShowMove} onReload={load} t={t} />
          ))}
        </div>
      )}

      {showAdd && (
        <AddPartnerDialog
          onClose={() => setShowAdd(false)}
          onDone={() => { setShowAdd(false); load(); }}
          t={t}
        />
      )}
      {showMove && (
        <MoveMoneyDialog
          partner={showMove.partner}
          kind={showMove.kind}
          cashAccounts={cashAccounts}
          onClose={() => setShowMove(null)}
          onDone={() => { setShowMove(null); load(); }}
          t={t}
        />
      )}
    </div>
  );
}

function PartnerCard({ partner: p, onMove, onReload, t }: {
  partner: Partner;
  onMove: (m: { partner: Partner; kind: "contribute" | "draw" }) => void;
  onReload: () => void;
  t: (k: string) => string;
}) {
  const total = BigInt(p.capitalBalance) + BigInt(p.currentBalance);
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-3">
          <span className="tile tile-primary h-11 w-11 !rounded-2xl text-lg font-extrabold">
            {p.name.charAt(0).toUpperCase()}
          </span>
          <div>
            <p className="font-extrabold">{p.name}</p>
            <p className="text-xs text-muted-foreground">{(p.profitShareBps / 100).toFixed(1)}% {t("partners.share")}</p>
          </div>
        </div>
        {!p.isActive && (
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-bold text-muted-foreground">
            {t("partners.inactive")}
          </span>
        )}
      </div>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">{t("partners.capital")}</p>
          <p className="mt-0.5 font-extrabold tabular-nums">{fmtMoney(BigInt(p.capitalBalance))}</p>
        </div>
        <div className="rounded-xl bg-muted/40 p-3">
          <p className="text-xs text-muted-foreground">{t("partners.current")}</p>
          <p className="mt-0.5 font-extrabold tabular-nums">{fmtMoney(BigInt(p.currentBalance))}</p>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
        <span className="text-sm text-muted-foreground">{t("partners.totalEquity")}</span>
        <span className="font-extrabold text-primary tabular-nums">{fmtMoney(total)}</span>
      </div>
      <div className="mt-3 flex gap-2">
        <button className="btn btn-secondary flex-1 !py-2 text-xs" onClick={() => onMove({ partner: p, kind: "contribute" })}>
          <TrendingUp size={14} /> {t("partners.addCapital")}
        </button>
        <button className="btn btn-secondary flex-1 !py-2 text-xs" onClick={() => onMove({ partner: p, kind: "draw" })}>
          <Wallet size={14} /> {t("partners.drawing")}
        </button>
      </div>
    </div>
  );
}

function AddPartnerDialog({ onClose, onDone, t }: {
  onClose: () => void; onDone: () => void; t: (k: string) => string;
}) {
  const [name, setName] = useState("");
  const [share, setShare] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api("/api/partners", {
        method: "POST",
        body: JSON.stringify({
          name,
          profitShareBps: Math.round(parseFloat(share || "0") * 100),
          phone: phone || undefined,
        }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-3">
            <span className="tile tile-primary h-11 w-11 !rounded-2xl"><Handshake size={20} /></span>
            <div>
              <h2 className="font-display text-lg font-extrabold">{t("partners.addPartner")}</h2>
              <p className="text-xs text-muted-foreground">{t("partners.addHint")}</p>
            </div>
          </div>
          <button className="btn btn-ghost !p-2 !rounded-xl" onClick={onClose}><X size={16} /></button>
        </div>
        <ErrorNote message={err} />
        <div className="mt-4 space-y-4">
          <Field label={t("partners.name")} required>
            <input className="input !rounded-xl !border-2 !border-border bg-background" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("partners.namePh")} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label={t("partners.profitShare")} required hint={t("partners.profitShareHint")}>
              <input type="number" min="0" max="100" step="0.1" className="input !rounded-xl !border-2 !border-border bg-background" value={share} onChange={(e) => setShare(e.target.value)} placeholder="50" />
            </Field>
            <Field label={t("partners.phone")}>
              <input className="input !rounded-xl !border-2 !border-border bg-background" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="03xx xxxxxxx" />
            </Field>
          </div>
        </div>
        <div className="mt-6 flex justify-end gap-2.5 border-t border-border/60 pt-5">
          <button className="btn btn-ghost !rounded-xl" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary !rounded-xl shadow-lg shadow-primary/25" disabled={busy || !name || !share} onClick={save}>
            {busy ? "…" : t("partners.addPartner")}
          </button>
        </div>
      </div>
    </div>
  );
}

function MoveMoneyDialog({ partner, kind, cashAccounts, onClose, onDone, t }: {
  partner: Partner; kind: "contribute" | "draw";
  cashAccounts: CashAccount[];
  onClose: () => void; onDone: () => void; t: (k: string) => string;
}) {
  const [amount, setAmount] = useState("");
  const [accountId, setAccountId] = useState(cashAccounts[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const save = async () => {
    setBusy(true); setErr("");
    try {
      await api(`/api/partners/${partner.id}/${kind === "contribute" ? "contribute" : "draw"}`, {
        method: "POST",
        body: JSON.stringify({ amount, accountId }),
      });
      onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Failed"); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-4 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div className="w-full max-w-md rounded-3xl border border-border/60 bg-card p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between">
          <h2 className="font-display text-lg font-extrabold">
            {kind === "contribute" ? t("partners.addCapital") : t("partners.drawing")} — {partner.name}
          </h2>
          <button className="btn btn-ghost !p-2 !rounded-xl" onClick={onClose}><X size={16} /></button>
        </div>
        <ErrorNote message={err} />
        <div className="mt-4 space-y-4">
          <Field label={t("partners.amount")} required>
            <input inputMode="decimal" className="input !rounded-xl !border-2 !border-border bg-background text-lg font-bold tabular-nums" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" />
          </Field>
          <Field label={t("partners.cashAccount")} required>
            <select className="input !rounded-xl !border-2 !border-border bg-background" value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              {cashAccounts.map((a) => <option key={a.id} value={a.id}>{a.code} — {a.name}</option>)}
            </select>
          </Field>
        </div>
        <div className="mt-6 flex justify-end gap-2.5 border-t border-border/60 pt-5">
          <button className="btn btn-ghost !rounded-xl" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn btn-primary !rounded-xl shadow-lg shadow-primary/25" disabled={busy || !amount || !accountId} onClick={save}>
            {busy ? "…" : t("common.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
