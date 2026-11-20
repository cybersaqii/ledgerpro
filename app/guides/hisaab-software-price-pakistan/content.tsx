import Link from "next/link";
import { BadgeCheck, Users, Building2, Cloud, ArrowRight } from "lucide-react";
import { brand } from "@/lib/brand";

const PLANS = [
  {
    name: "Starter",
    price: "Rs 1,500",
    per: "per month",
    icon: Users,
    for: "For small shops getting off the register.",
    points: ["All basic features", "Advanced reports (P&L, balance sheet)", "CSV import & export", "1 company, 1 user"],
  },
  {
    name: "Professional",
    price: "Rs 2,000",
    per: "per month",
    icon: Building2,
    for: "Most popular — for a growing business with staff and more than one company.",
    points: ["Everything in Starter", "POS retail terminal", "Staff accounts & permissions", "Accounting period lock", "Up to 3 companies"],
  },
  {
    name: "Enterprise",
    price: "Rs 3,500",
    per: "per month",
    icon: Cloud,
    for: "For growing chains that need the full platform and priority support.",
    points: ["Everything in Professional", "Unlimited companies", "Offline sync for the mobile app", "Priority support"],
  },
];

const CHECKS = [
  {
    t: "Try it before you pay for it",
    d: "A 30-day free trial should be enough to run a real week of billing — your own parties, your own stock, your own bills. If a vendor only offers a demo video, you have not tried the software.",
  },
  {
    t: "Check what the price leaves out",
    d: "Ask whether sync, extra users, branches or support cost more on top of the headline price. LedgerPro lists its three plans openly on the pricing page — the price shown is the price.",
  },
  {
    t: "Make sure your data can leave",
    d: "Before paying any vendor, confirm you can export your parties, products and ledgers. Your hisaab belongs to you; a fair price never holds it hostage.",
  },
  {
    t: "Match the plan to the shop, not the other way round",
    d: "A single counter does not need enterprise limits, and a three-godown wholesaler will outgrow a starter plan in a month. Start small, upgrade when the work — not the sales pitch — says so.",
  },
];

const FAQS = [
  {
    q: "Is there really a free trial?",
    a: "Yes — every new company gets a 30-day free trial with full Pro access, and no credit card is needed to start.",
  },
  {
    q: "Are the prices in rupees?",
    a: "Yes. All three plans are billed in Pakistani rupees: Starter Rs 1,500, Professional Rs 2,000 and Enterprise Rs 3,500 per month (yearly billing is also available: Rs 15,000, Rs 20,000 and Rs 35,000 per year).",
  },
  {
    q: "Does the price include the offline app?",
    a: "Yes — the Android app works offline on every plan. Offline sync for the mobile app is an Enterprise feature.",
  },
];

export default function PriceContent() {
  const b = brand.name;
  return (
    <main>
      <section className="relative overflow-hidden bg-[#0a1120] text-white">
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 sm:px-8 sm:py-24">
          <p className="text-xs font-extrabold uppercase tracking-widest text-amber-400">Guides · Pricing</p>
          <h1 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
            Hisaab software price in Pakistan — what should you pay?
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            Prices for hisaab software in Pakistan range from free khata apps to enterprise systems.
            This page states {b}&rsquo;s actual prices plainly, and what to check before you pay any vendor.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/pricing" className="btn !border-0 !bg-white !px-6 !py-3 !text-sm !text-[#101a2c] shadow-lg hover:!bg-slate-100">
              See full pricing <ArrowRight size={15} />
            </Link>
            <Link href="/download" className="btn !border !border-white/30 !px-6 !py-3 !text-sm !text-white hover:!bg-white/10">
              Start free trial
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">{b} plans, in rupees</h2>
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {PLANS.map((p) => (
            <article key={p.name} className="rounded-2xl border border-border bg-card p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <p.icon size={20} />
              </span>
              <h3 className="mt-3 text-lg font-extrabold">{p.name}</h3>
              <p className="mt-1 text-2xl font-extrabold tabular-nums">{p.price} <span className="text-sm font-semibold text-muted-foreground">{p.per}</span></p>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{p.for}</p>
              <ul className="mt-3 space-y-1.5">
                {p.points.map((pt) => (
                  <li key={pt} className="flex items-start gap-2 text-sm">
                    <BadgeCheck size={15} className="mt-0.5 shrink-0 text-primary" /> {pt}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
        <p className="mt-4 text-sm text-muted-foreground">
          Prices as listed on the <Link href="/pricing" className="font-bold text-primary hover:underline">pricing page</Link>. Every plan starts with a 30-day free trial.
        </p>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-14 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">Before you pay any vendor</h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {CHECKS.map((c) => (
            <article key={c.t} className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-extrabold">{c.t}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">Common questions</h2>
        <div className="mt-6 space-y-4">
          {FAQS.map((f) => (
            <article key={f.q} className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-extrabold">{f.q}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </article>
          ))}
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          Related: <Link href="/guides/wholesale-hisaab-software" className="font-bold text-primary hover:underline">wholesale hisaab guide</Link> ·{" "}
          <Link href="/guides/offline-hisaab-app" className="font-bold text-primary hover:underline">offline guide</Link>.
        </p>
      </section>
    </main>
  );
}
