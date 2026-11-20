"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Store, ShoppingCart, Truck, Pill, Stethoscope, UtensilsCrossed,
  Wrench, Factory, LayoutGrid, Check, ArrowRight, ArrowLeft, SkipForward, Sparkles,
} from "lucide-react";
import { api } from "@/lib/format";
import { useLang } from "@/components/lang-provider";
import { Field, ErrorNote } from "@/components/ui";
import { getBusinessProfile, newSaleHref, BUSINESS_TYPES, businessTypeLabel } from "@/lib/business-types";

const ICONS: Record<string, typeof Store> = {
  WHOLESALE: Store,
  RETAIL: ShoppingCart,
  DISTRIBUTION: Truck,
  PHARMACY: Pill,
  CLINIC: Stethoscope,
  RESTAURANT: UtensilsCrossed,
  SERVICES: Wrench,
  MANUFACTURING: Factory,
  OTHER: LayoutGrid,
};

/** First bill destination per business type — single source of truth in lib/business-types. */
function firstBillHref(businessType: string): string {
  return newSaleHref(getBusinessProfile(businessType));
}

export default function WelcomePage() {
  const router = useRouter();
  const { t } = useLang();
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [businessType, setBusinessType] = useState("OTHER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Step 2 fields
  const [prodName, setProdName] = useState("");
  const [prodPrice, setProdPrice] = useState("");
  const [partyName, setPartyName] = useState("");
  const [partyPhone, setPartyPhone] = useState("");
  const [partyKind, setPartyKind] = useState<"CUSTOMER" | "SUPPLIER">("CUSTOMER");

  useEffect(() => {
    api<{ data: { completed: boolean; businessType: string } }>("/api/onboarding/wizard")
      .then((d) => {
        if (d.data.completed) {
          router.replace("/dashboard");
          return;
        }
        setBusinessType(d.data.businessType || "OTHER");
      })
      .catch(() => setError(t("onboarding.loadError")))
      .finally(() => setLoading(false));
  }, [router, t]);

  async function saveType(next: string) {
    setBusinessType(next);
    try {
      await api("/api/onboarding/wizard", {
        method: "POST",
        body: JSON.stringify({ businessType: next }),
      });
    } catch {
      /* non-fatal; the final complete call re-sends it */
    }
  }

  async function finish(skip: boolean) {
    setBusy(true);
    setError(null);
    try {
      if (step === 1 && !skip) {
        // Persist the quick-add entries before moving on.
        await api("/api/onboarding/quick-add", {
          method: "POST",
          body: JSON.stringify({
            product: prodName.trim() ? { name: prodName.trim(), salePrice: prodPrice } : undefined,
            party: partyName.trim()
              ? { name: partyName.trim(), phone: partyPhone.trim(), kind: partyKind }
              : undefined,
          }),
        });
      }
      if (step === 2 || skip) {
        await api("/api/onboarding/wizard", {
          method: "POST",
          body: JSON.stringify({ businessType, completed: true }),
        });
        router.push(skip ? "/dashboard" : firstBillHref(businessType));
        router.refresh();
        return;
      }
      // Step 0 (business type) is already saved on select; re-save the
      // loaded default too so a user who never taps a card still persists it.
      if (step === 0) await saveType(businessType);
      setStep(step + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("onboarding.saveError"));
    } finally {
      setBusy(false);
    }
  }

  // Phase 3: the ready screen shows the ACTUAL selected type and the actual
  // first-bill destination (POS for retail/restaurant, bill form otherwise).
  const billHref = firstBillHref(businessType);
  const billWhere = billHref.includes("/pos") ? t("onboarding.posMode") : t("onboarding.billMode");

  if (loading) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-10">
      {/* Progress */}
      <div className="mb-8 flex items-center gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-sm font-extrabold ${
                i < step ? "bg-primary text-primary-foreground" : i === step ? "bg-primary/15 text-primary ring-2 ring-primary" : "bg-muted text-muted-foreground"
              }`}
            >
              {i < step ? <Check size={16} /> : i + 1}
            </div>
            {i < 2 && <div className={`h-1 flex-1 rounded-full ${i < step ? "bg-primary" : "bg-muted"}`} />}
          </div>
        ))}
      </div>

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* Phase 3: step 0 — business type picker (was missing entirely). */}
      {step === 0 && (
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t("onboarding.step1Title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.step1Hint")}</p>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            {BUSINESS_TYPES.map((bt) => {
              const Icon = ICONS[bt.value] ?? LayoutGrid;
              const selected = businessType === bt.value;
              return (
                <button
                  key={bt.value}
                  type="button"
                  onClick={() => saveType(bt.value)}
                  aria-pressed={selected}
                  className={`flex items-start gap-3 rounded-2xl border p-4 text-start transition ${
                    selected ? "border-primary bg-primary-soft/40 ring-2 ring-primary" : "border-border hover:border-primary/50"
                  }`}
                >
                  <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl ${selected ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    <Icon size={20} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-extrabold">{t(bt.label)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(bt.hint)}</span>
                  </span>
                  {selected && <Check size={16} className="ms-auto shrink-0 text-primary" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {step === 1 && (
        <div>
          <h1 className="text-2xl font-extrabold tracking-tight">{t("onboarding.step2Title")}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t("onboarding.step2Hint")}</p>
          <div className="mt-6 space-y-6">
            <div className="rounded-2xl border border-border p-4">
              <p className="mb-3 text-sm font-extrabold">{t("onboarding.firstProduct")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("onboarding.productName")}>
                  <input className="field" value={prodName} onChange={(e) => setProdName(e.target.value)} maxLength={120} placeholder={t("onboarding.productNamePh")} />
                </Field>
                <Field label={t("onboarding.salePrice")}>
                  <input className="field" type="number" min="0" step="0.01" value={prodPrice} onChange={(e) => setProdPrice(e.target.value)} placeholder="0.00" />
                </Field>
              </div>
            </div>
            <div className="rounded-2xl border border-border p-4">
              <p className="mb-3 text-sm font-extrabold">{t("onboarding.firstParty")}</p>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label={t("onboarding.partyName")}>
                  <input className="field" value={partyName} onChange={(e) => setPartyName(e.target.value)} maxLength={120} placeholder={t("onboarding.partyNamePh")} />
                </Field>
                <Field label={t("onboarding.partyPhone")}>
                  <input className="field" type="tel" dir="ltr" value={partyPhone} onChange={(e) => setPartyPhone(e.target.value)} maxLength={30} placeholder="03xx…" />
                </Field>
              </div>
              <div className="mt-3 flex gap-2">
                {(["CUSTOMER", "SUPPLIER"] as const).map((k) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setPartyKind(k)}
                    className={`rounded-full px-4 py-1.5 text-sm font-bold ${partyKind === k ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}
                  >
                    {t(`onboarding.kind${k === "CUSTOMER" ? "Customer" : "Supplier"}`)}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="text-center">
          <span className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Sparkles size={28} />
          </span>
          <h1 className="mt-4 text-2xl font-extrabold tracking-tight">{t("onboarding.step3Title")}</h1>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t("onboarding.step3Hint")}</p>
          <div className="mx-auto mt-6 max-w-md rounded-2xl border border-border bg-card p-5 text-start">
            <p className="text-sm font-bold">{t("onboarding.readyList")}</p>
            <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
              <li className="flex items-center gap-2"><Check size={14} className="text-primary" /> {t("onboarding.readyType", { type: t(businessTypeLabel(businessType)) })}</li>
              {(prodName.trim() || partyName.trim()) && (
                <li className="flex items-center gap-2"><Check size={14} className="text-primary" /> {t("onboarding.readyData")}</li>
              )}
              <li className="flex items-center gap-2"><Check size={14} className="text-primary" /> {t("onboarding.readyBill", { where: billWhere })}</li>
            </ul>
          </div>
        </div>
      )}

      {/* Nav */}
      <div className="mt-8 flex items-center justify-between">
        <div className="flex items-center gap-2">
          {step > 0 && (
            <button type="button" onClick={() => setStep(step - 1)} className="btn btn-ghost" disabled={busy}>
              <ArrowLeft size={16} className="rtl:rotate-180" /> {t("onboarding.back")}
            </button>
          )}
          {/* Skip is available on every step. */}
          <button type="button" onClick={() => finish(true)} className="btn btn-ghost" disabled={busy}>
            <SkipForward size={16} /> {t("onboarding.skip")}
          </button>
        </div>
        <button type="button" onClick={() => finish(false)} className="btn btn-primary" disabled={busy}>
          {busy ? "…" : step === 2 ? t("onboarding.createBill") : t("onboarding.continue")} <ArrowRight size={16} className="rtl:rotate-180" />
        </button>
      </div>
    </div>
  );
}
