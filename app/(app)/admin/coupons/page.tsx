"use client";

import { useState, useEffect } from "react";
import { Tag, Plus, Check, X, Trash2, ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PageHeader, Field, ErrorNote, EmptyState } from "@/components/ui";
import { api, fmtMoney } from "@/lib/format";
import { useLang } from "@/components/lang-provider";

type Coupon = {
  id: string; code: string; kind: "PERCENT" | "FIXED"; value: number;
  maxUses: number | null; usedCount: number;
  validFrom: string | null; validTo: string | null;
  active: boolean; createdBy: string | null; createdAt: string;
};

export default function AdminCouponsPage() {
  const { t } = useLang();
  const [coupons, setCoupons] = useState<Coupon[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [code, setCode] = useState("");
  const [kind, setKind] = useState<"PERCENT" | "FIXED">("PERCENT");
  const [value, setValue] = useState("");
  const [maxUses, setMaxUses] = useState("");
  const [validFrom, setValidFrom] = useState("");
  const [validTo, setValidTo] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const d = await api<{ data: Coupon[] }>("/api/admin/coupons");
      setCoupons(d.data);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("adminCoupons.loadError"));
    } finally {
      setLoading(false);
    }
  }
  // Initial data load on mount.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  async function create() {
    setError(null);
    if (code.trim().length < 3) { setError(t("adminCoupons.codeError")); return; }
    if (!Number(value) || Number(value) <= 0) { setError(t("adminCoupons.valueError")); return; }
    setBusy(true);
    try {
      await api("/api/admin/coupons", {
        method: "POST",
        body: JSON.stringify({
          code: code.trim(), kind,
          value: kind === "PERCENT" ? Number(value) : Math.round(Number(value) * 100),
          maxUses: maxUses ? Number(maxUses) : null,
          validFrom: validFrom || null, validTo: validTo || null,
        }),
      });
      setShowForm(false);
      setCode(""); setValue(""); setMaxUses(""); setValidFrom(""); setValidTo("");
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("adminCoupons.createError"));
    } finally {
      setBusy(false);
    }
  }

  async function toggle(c: Coupon) {
    try {
      await api(`/api/admin/coupons/${c.id}`, { method: "PATCH", body: JSON.stringify({ active: !c.active }) });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("adminCoupons.updateError"));
    }
  }

  async function remove(c: Coupon) {
    if (!confirm(t("adminCoupons.deleteConfirm", { code: c.code }))) return;
    try {
      await api(`/api/admin/coupons/${c.id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("adminCoupons.deleteError"));
    }
  }

  const fmtValue = (c: Coupon) => c.kind === "PERCENT" ? `${c.value}%` : fmtMoney(c.value);

  return (
    <div className="space-y-6">
      <Link href="/admin/billing" className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted-foreground hover:text-foreground">
        <ArrowLeft size={15} className="rtl:rotate-180" /> {t("adminCoupons.adminBilling")}
      </Link>
      <PageHeader
        title={t("adminCoupons.title")}
        subtitle={t("adminCoupons.subtitle")}
        icon={<Tag size={22} />}
      />

      <div className="flex justify-end">
        <button onClick={() => setShowForm((v) => !v)} className="btn btn-primary">
          <Plus size={16} /> {t("adminCoupons.newCoupon")}
        </button>
      </div>

      {showForm && (
        <div className="card space-y-4 p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Field label={t("adminCoupons.code")} hint={t("adminCoupons.codeHint")}>
              <input className="field font-mono uppercase tracking-widest" value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 24))} maxLength={24} />
            </Field>
            <Field label={t("adminCoupons.type")}>
              <select className="field" value={kind} onChange={(e) => setKind(e.target.value as "PERCENT" | "FIXED")}>
                <option value="PERCENT">{t("adminCoupons.percent")}</option>
                <option value="FIXED">{t("adminCoupons.fixed")}</option>
              </select>
            </Field>
            <Field label={kind === "PERCENT" ? t("adminCoupons.percentLabel") : t("adminCoupons.amountLabel")}>
              <input className="field" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label={t("adminCoupons.maxUses")}>
              <input className="field" inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value.replace(/[^0-9]/g, ""))} placeholder={t("adminCoupons.unlimited")} />
            </Field>
            <Field label={t("adminCoupons.validFrom")}>
              <input type="date" className="field" value={validFrom} onChange={(e) => setValidFrom(e.target.value)} />
            </Field>
            <Field label={t("adminCoupons.validTo")}>
              <input type="date" className="field" value={validTo} onChange={(e) => setValidTo(e.target.value)} />
            </Field>
          </div>
          <ErrorNote message={error} />
          <button onClick={create} disabled={busy} className="btn btn-accent">
            {busy ? t("adminCoupons.creating") : t("adminCoupons.create")}
          </button>
        </div>
      )}

      <div className="card p-5 sm:p-6">
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("adminCoupons.loading")}</p>
        ) : coupons.length === 0 ? (
          <EmptyState title={t("adminCoupons.emptyTitle")} hint={t("adminCoupons.emptyHint")} />
        ) : (
          <div className="space-y-2">
            {coupons.map((c) => (
              <div key={c.id} className="card-lift flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <span className={`tile h-10 w-10 ${c.active ? "tile-primary" : "bg-muted text-muted-foreground"}`}>
                    <Tag size={17} />
                  </span>
                  <div>
                    <p className="font-mono font-extrabold tracking-widest">{c.code}</p>
                    <p className="text-xs text-muted-foreground">
                      {fmtValue(c)} {t("adminCoupons.off")} · {c.usedCount}{c.maxUses != null ? `/${c.maxUses}` : ""} {t("adminCoupons.used")}
                      {c.validFrom || c.validTo ? ` · ${c.validFrom?.slice(0, 10) ?? "…"} → ${c.validTo?.slice(0, 10) ?? "…"}` : ""}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${c.active ? "bg-success-soft text-success" : "bg-muted text-muted-foreground"}`}>
                    {c.active ? t("adminCoupons.active") : t("adminCoupons.paused")}
                  </span>
                  <button onClick={() => toggle(c)} className="btn btn-ghost !min-h-11 !min-w-11 !px-2.5 !py-1.5 text-xs" aria-label={c.active ? t("adminCoupons.pause") : t("adminCoupons.activate")}>
                    {c.active ? <X size={14} /> : <Check size={14} />}
                  </button>
                  <button onClick={() => remove(c)} className="btn btn-ghost !min-h-11 !min-w-11 !px-2.5 !py-1.5 text-xs text-danger" aria-label={t("adminCoupons.delete")}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
