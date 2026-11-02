"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowRight, BadgeCheck, CheckCircle2, ShieldCheck } from "lucide-react";
import { useLang } from "@/components/lang-provider";

const starterFeatures = ["sf0", "sf1", "sf2", "sf3"];
const proFeatures = ["pf0", "pf1", "pf2", "pf3", "pf4"];
const enterpriseFeatures = ["ef0", "ef1", "ef2", "ef3"];

/**
 * Pricing section, shared by the landing page (#pricing) and the
 * standalone /pricing page.
 *
 * Three paid cards only: Starter, Professional, Enterprise. The Free
 * card was removed 2026-11-02 per user decision (it had only just been
 * added in the Nov 1 sweep fix round) — the Free tier still exists in
 * entitlements, it is simply no longer shown as a card. Starter's first
 * bullet therefore says "All basic features" instead of pointing at a
 * card that no longer exists.
 *
 * Layout notes: the MOST POPULAR badge straddles the Pro card's top
 * edge, centered — it used to sit top-right inside the card and covered
 * the PROFESSIONAL title. Price amounts are whitespace-nowrap so
 * "Rs 1,500" never splits across lines in a narrow card.
 */
export default function PricingSection() {
  const { t } = useLang();
  const L = (k: string, vars?: Record<string, string | number>) => t(`landing.${k}`, vars);
  const [billing, setBilling] = useState<"m" | "y">("m");
  return (
    <section id="pricing" className="relative scroll-mt-24 overflow-hidden bg-gradient-to-b from-background via-[#fdf6e3] to-background dark:via-[#f0b73f]/[0.05]">
      <div className="relative mx-auto max-w-[1200px] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
        <div className="text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
            <BadgeCheck size={13} /> {L("pricingKicker")}
          </span>
          <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("pricingTitleA")}<br />{L("pricingTitleB")}</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("pricingSub")}</p>
          <div className="mt-6 inline-flex items-center rounded-full border border-border bg-card p-1 shadow-sm" role="group" aria-label={L("pricingKicker")}>
            {(["m", "y"] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setBilling(v)}
                aria-pressed={billing === v}
                className={`rounded-full px-5 py-2 text-sm font-bold transition ${billing === v ? "bg-primary text-primary-foreground shadow" : "text-muted-foreground hover:text-foreground"}`}
              >
                {L(v === "m" ? "monthly" : "yearly")}
                {v === "y" && <span className="ms-1.5 rounded-full bg-[#f0b73f] px-2 py-0.5 text-[0.65rem] font-extrabold text-[#231600]">{L("yearlySave")}</span>}
              </button>
            ))}
          </div>
        </div>
        <div className="mx-auto mt-10 grid max-w-6xl gap-6 md:grid-cols-2 lg:grid-cols-3">
          {/* Starter */}
          <div className="card flex flex-col p-7 sm:p-8">
            <p className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{L("planStarter")}</p>
            <p className="mt-3 flex items-baseline gap-1">
              <span className="font-display whitespace-nowrap text-4xl font-extrabold tracking-tight">{billing === "m" ? L("starterMonthlyPrice") : L("starterYearlyPrice")}</span>
              <span className="text-sm text-muted-foreground">{billing === "m" ? L("perMonth") : L("perYear")}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{billing === "y" ? L("billedYearly") : "\u00A0"}</p>
            <ul className="mt-5 flex-1 space-y-3">
              {starterFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-primary" />
                  <span>{L(f)}</span>
                </li>
              ))}
            </ul>
            <Link href="/signup" className="btn btn-ghost mt-7 w-full !py-3 text-sm">
              {L("ctaPro")} <ArrowRight size={16} />
            </Link>
          </div>
          {/* Professional — highlighted. No overflow-hidden: the badge
              straddles the top edge, so clipping would cut it in half. */}
          <div className="relative flex flex-col rounded-3xl border-2 border-[#f0b73f] bg-[#101a2c] p-7 shadow-2xl shadow-[#f0b73f]/15 sm:p-8">
            <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 rounded-full bg-[#f0b73f] px-3 py-1 text-[0.7rem] font-extrabold uppercase tracking-wide whitespace-nowrap text-[#231600]">{L("proTag")}</span>
            <p className="text-sm font-extrabold uppercase tracking-wider text-[#f0b73f]">{L("planProfessional")}</p>
            <p className="mt-3 flex items-baseline gap-1">
              <span className="font-display whitespace-nowrap text-4xl font-extrabold tracking-tight text-white">{billing === "m" ? L("proMonthlyPrice") : L("proYearlyPrice")}</span>
              <span className="text-sm text-white/75">{billing === "m" ? L("perMonth") : L("perYear")}</span>
            </p>
            <p className="mt-1 text-xs text-white/65">{billing === "y" ? L("billedYearly") : "\u00A0"}</p>
            <ul className="mt-5 flex-1 space-y-3">
              {proFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm text-white/90">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-[#f0b73f]" />
                  <span>{L(f)}</span>
                </li>
              ))}
            </ul>
            <Link href="/signup" className="mt-7 inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-[#f0b73f] !py-3 text-sm font-extrabold text-[#231600] transition hover:brightness-105">
              {L("ctaPro")} <ArrowRight size={16} />
            </Link>
          </div>
          {/* Enterprise */}
          <div className="card flex flex-col p-7 sm:p-8">
            <p className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{L("planEnterprise")}</p>
            <p className="mt-3 flex items-baseline gap-1">
              <span className="font-display whitespace-nowrap text-4xl font-extrabold tracking-tight">{billing === "m" ? L("enterpriseMonthlyPrice") : L("enterpriseYearlyPrice")}</span>
              <span className="text-sm text-muted-foreground">{billing === "m" ? L("perMonth") : L("perYear")}</span>
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{billing === "y" ? L("billedYearly") : "\u00A0"}</p>
            <ul className="mt-5 flex-1 space-y-3">
              {enterpriseFeatures.map((f) => (
                <li key={f} className="flex items-start gap-2.5 text-sm">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-primary" />
                  <span>{L(f)}</span>
                </li>
              ))}
            </ul>
            <Link href="/signup" className="btn btn-ghost mt-7 w-full !py-3 text-sm">
              {L("ctaPro")} <ArrowRight size={16} />
            </Link>
          </div>
        </div>
        <p className="mx-auto mt-8 flex max-w-xl items-start justify-center gap-2 text-center text-sm text-muted-foreground">
          <ShieldCheck size={17} className="mt-0.5 shrink-0 text-primary" />
          <span>{L("trialNote")}</span>
        </p>
        {/* How PRO activation works */}
        <div className="mx-auto mt-8 max-w-3xl rounded-3xl border border-border bg-card p-6 shadow-sm sm:p-7">
          <p className="text-center text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{L("activateTitle")}</p>
          <ol className="mt-5 grid gap-4 sm:grid-cols-3">
            {[L("activateStep1"), L("activateStep2"), L("activateStep3")].map((s, i) => (
              <li key={i} className="flex items-start gap-3">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary/10 text-sm font-extrabold text-primary">{i + 1}</span>
                <span className="pt-1 text-sm leading-relaxed">{s}</span>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
