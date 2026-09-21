"use client";

import Link from "next/link";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, ReceiptText, TrendingUp, Users, Wallet,
  Store, Factory, Stethoscope, Pill, UtensilsCrossed, Briefcase, Truck,
  TriangleAlert, XCircle, BadgeCheck,
} from "lucide-react";
import { ThemeToggle, LangToggle } from "@/components/ui";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

const features = [
  { icon: FileText, t: "f0t", d: "f0d" },
  { icon: Boxes, t: "f1t", d: "f1d" },
  { icon: Wallet, t: "f2t", d: "f2d" },
  { icon: BarChart3, t: "f3t", d: "f3d" },
  { icon: ScanBarcode, t: "f4t", d: "f4d" },
  { icon: ShieldCheck, t: "f5t", d: "f5d" },
  { icon: Users, t: "f6t", d: "f6d" },
  { icon: Landmark, t: "f7t", d: "f7d" },
  { icon: Smartphone, t: "f8t", d: "f8d" },
];

const businessTypes = [
  { icon: Boxes, l: "mq0", grad: "from-emerald-500 to-teal-600", glow: "group-hover:shadow-emerald-500/30" },
  { icon: Store, l: "mq1", grad: "from-amber-500 to-orange-600", glow: "group-hover:shadow-amber-500/30" },
  { icon: Truck, l: "mq2", grad: "from-blue-500 to-indigo-600", glow: "group-hover:shadow-blue-500/30" },
  { icon: Pill, l: "mq3", grad: "from-cyan-500 to-sky-600", glow: "group-hover:shadow-cyan-500/30" },
  { icon: Stethoscope, l: "mq4", grad: "from-rose-500 to-pink-600", glow: "group-hover:shadow-rose-500/30" },
  { icon: UtensilsCrossed, l: "mq5", grad: "from-orange-500 to-red-500", glow: "group-hover:shadow-orange-500/30" },
  { icon: Briefcase, l: "mq6", grad: "from-violet-500 to-purple-600", glow: "group-hover:shadow-violet-500/30" },
  { icon: Factory, l: "mq7", grad: "from-slate-500 to-slate-700", glow: "group-hover:shadow-slate-500/30" },
];

const featureGrads = [
  "from-emerald-500 to-teal-600",
  "from-amber-500 to-orange-600",
  "from-blue-500 to-indigo-600",
  "from-cyan-500 to-sky-600",
  "from-rose-500 to-pink-600",
  "from-violet-500 to-purple-600",
];

const steps = [
  { n: "1", t: "s0t", d: "s0d" },
  { n: "2", t: "s1t", d: "s1d" },
  { n: "3", t: "s2t", d: "s2d" },
];

const faqs = [
  { q: "q0", a: "a0" },
  { q: "q1", a: "a1" },
  { q: "q2", a: "a2" },
  { q: "q3", a: "a3" },
  { q: "q4", a: "a4" },
];

const trust = [
  { t: "tr0t", d: "tr0d", icon: Landmark, grad: "from-emerald-500 to-teal-600" },
  { t: "tr1t", d: "tr1d", icon: Users, grad: "from-amber-500 to-orange-600" },
  { t: "tr2t", d: "tr2d", icon: ShieldCheck, grad: "from-blue-500 to-indigo-600" },
];

const heroPoints = ["hp0", "hp1", "hp2", "hp3"];
const paperBad = ["pp0", "pp1", "pp2", "pp3"];
const paperGood = ["lp0", "lp1", "lp2", "lp3"];
const madeFor = ["mf0", "mf1", "mf2", "mf3", "mf4", "mf5"];
const footLinks: [string, string][] = [["fl0", "#features"], ["fl1", "#businesses"], ["fl2", "#how"], ["fl3", "#faq"], ["fl4", "/login"]];

export default function LandingContent() {
  const { t } = useLang();
  const b = brand.name;
  const L = (k: string, vars?: Record<string, string | number>) => t(`landing.${k}`, vars);
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-[#0a2e25]/85 backdrop-blur-xl">
        <div className="flex h-16 items-center justify-between px-4 sm:px-8 lg:px-12">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-white/15 shadow-lg">
              <FileText size={18} className="text-white" />
            </span>
            <span className="hidden min-[420px]:block">
              <span className="block text-[1.05rem] font-extrabold leading-none tracking-tight text-white">{b}</span>
              <span className="hidden text-[0.68rem] text-emerald-100/70 sm:block">{brand.tagline}</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-semibold text-emerald-50/85 md:flex">
            <a href="#features" className="transition hover:text-white">{L("navFeatures")}</a>
            <a href="#businesses" className="transition hover:text-white">{L("navBusinesses")}</a>
            <a href="#how" className="transition hover:text-white">{L("navHow")}</a>
            <a href="#faq" className="transition hover:text-white">{L("navFaq")}</a>
          </nav>
          <div className="flex items-center gap-1.5 sm:gap-3">
            <LangToggle />
            <ThemeToggle />
            <Link href="/login" className="hidden rounded-xl px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 sm:inline-flex">{L("navLogin")}</Link>
            <Link href="/signup" className="btn shrink-0 !border-0 !bg-white !px-3 !py-2 text-[0.8rem] !text-[#0a2e25] hover:!bg-emerald-50 sm:!px-4 sm:text-sm">
              {L("navStart")} <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — rich dark */}
      <section className="relative">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0b3d31]" />
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/4 h-[420px] w-[620px] rounded-full bg-emerald-400/20 blur-[130px]" />
          <div className="absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-teal-300/15 blur-[110px]" />
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "30px 30px" }} />
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background to-transparent" />
        </div>
        <div className="relative grid items-center gap-12 px-4 pb-16 pt-32 sm:px-8 sm:pt-40 lg:grid-cols-2 lg:gap-12 lg:px-12 lg:pb-20">
          <div className="text-center lg:text-left">
            <div className="rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-emerald-50 shadow-sm backdrop-blur">
              <BadgeCheck size={14} className="text-amber-300" />
              {L("heroBadge")}
            </div>
            <h1 className="rise rise-1 mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-[3.6rem]">
              {L("heroTitleA")}{" "}
              <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">{L("heroTitleMid")}</span>
              {L("heroTitleB")}
            </h1>
            <p className="rise rise-2 mt-5 max-w-xl text-base text-emerald-50/80 sm:text-lg lg:mx-0">
              {L("heroSubA")} <span className="font-semibold text-white">{L("heroSubU")}</span> {L("heroSubB", { brand: b })}
            </p>
            <ul className="rise rise-3 mx-auto mt-7 grid max-w-xl gap-2.5 text-left sm:grid-cols-2 lg:mx-0">
              {heroPoints.map((k) => (
                <li key={k} className="flex items-start gap-2 text-sm font-medium text-emerald-50">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-300" />
                  {L(k)}
                </li>
              ))}
            </ul>
            <div className="rise rise-4 mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link href="/signup" className="btn !border-0 !bg-white !px-7 !py-3.5 !text-base !text-[#0a2e25] shadow-xl shadow-black/20 hover:!bg-emerald-50">
                {L("heroCtaStart")} <ArrowRight size={18} />
              </Link>
              <Link href="/login" className="btn !border-white/25 !bg-white/10 !px-7 !py-3.5 !text-base !text-white backdrop-blur hover:!bg-white/20">
                {L("heroCtaLogin")}
              </Link>
            </div>
            <p className="rise rise-4 mt-4 text-xs text-emerald-100/60">{L("heroMicro")}</p>
          </div>

          {/* Floating dashboard mock */}
          <div className="rise rise-2 relative lg:pl-6">
            <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-emerald-400/15 blur-3xl" />
            <div className="floaty absolute -top-6 right-2 z-10 hidden items-center gap-3 rounded-2xl border border-white/40 bg-white/95 p-3 pr-4 shadow-xl backdrop-blur md:flex">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                <CheckCircle2 size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-900">{L("mockPayTitle")}</span>
                <span className="block text-[0.7rem] text-slate-500">{L("mockPaySub")}</span>
              </span>
            </div>
            <div className="floaty absolute -bottom-7 left-0 z-10 hidden items-center gap-3 rounded-2xl border border-white/40 bg-white/95 p-3 pr-4 shadow-xl backdrop-blur md:flex" style={{ animationDelay: "-3.5s" }}>
              <span className="grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-amber-700">
                <TriangleAlert size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-900">{L("mockAlertTitle")}</span>
                <span className="block text-[0.7rem] text-slate-500">{L("mockAlertSub")}</span>
              </span>
            </div>
            <div className="floaty card card-gloss relative p-5 text-left shadow-2xl sm:p-7">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{L("mockToday")}</p>
                  <p className="mt-1 text-3xl font-extrabold tracking-tight">Rs 1,84,500</p>
                </div>
                <span className="badge bg-primary-soft text-primary"><TrendingUp size={13} /> {L("mockWeek")}</span>
              </div>
              <div className="mt-6 grid grid-cols-3 gap-3">
                {[
                  { l: L("mockReceive"), v: "Rs 96,200" },
                  { l: L("mockPay"), v: "Rs 41,750" },
                  { l: L("mockStock"), v: "Rs 5,20,000" },
                ].map((s) => (
                  <div key={s.l} className="rounded-xl bg-muted/70 p-3 sm:p-4">
                    <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">{s.l}</p>
                    <p className="mt-1 text-sm font-extrabold sm:text-lg">{s.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-end gap-1.5" aria-hidden>
                {[35, 55, 40, 70, 52, 88, 64, 95, 74, 100, 82, 92].map((h, i) => (
                  <div key={i} className="flex-1 rounded-t-md bg-gradient-to-t from-primary/70 to-primary/25" style={{ height: `${h * 0.9}px` }} />
                ))}
              </div>
            </div>
          </div>
        </div>
        {/* Business-type marquee */}
        <div className="relative z-10 border-t border-white/10 py-6">
          <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
            <div className="animate-marquee flex w-max items-center gap-10 pr-10">
              {[...businessTypes, ...businessTypes].map((bt, i) => (
                <span key={i} className="flex items-center gap-2 text-sm font-semibold tracking-wide text-emerald-50">
                  <bt.icon size={16} className="text-emerald-300" />
                  {L(bt.l)}
                </span>
              ))}
            </div>
          </div>
        </div>
        <div className="relative h-14" />
      </section>

      {/* Paper vs LedgerPro */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-emerald-300/25 blur-[100px]" />
          <div className="absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-amber-200/40 blur-[100px]" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-red-600">
              <TriangleAlert size={13} /> {L("paperKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("paperTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("paperSub")}</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2 md:gap-6">
            <div className="rounded-3xl border border-border bg-card/80 p-7 shadow-sm backdrop-blur transition hover:shadow-md sm:p-8">
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{L("paperColT")}</p>
              <ul className="mt-5 space-y-3.5">
                {paperBad.map((k) => (
                  <li key={k} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <XCircle size={17} className="mt-0.5 shrink-0 text-red-400" /> {L(k)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 p-[2px] shadow-xl shadow-emerald-500/20 transition hover:shadow-2xl hover:shadow-emerald-500/30">
              <div className="relative h-full rounded-[calc(1.5rem-2px)] bg-card p-7 sm:p-8">
                <span className="absolute -top-3.5 left-6 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wider text-white shadow-md">{L("recommended")}</span>
                <p className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-sm font-extrabold uppercase tracking-wider text-transparent">{b}</p>
                <ul className="mt-5 space-y-3.5">
                  {paperGood.map((k) => (
                    <li key={k} className="flex items-start gap-2.5 text-sm font-medium">
                      <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> {L(k)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn btn-primary !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              {L("paperCta")} <ArrowRight size={18} />
            </Link>
            <p className="mt-3 text-xs text-muted-foreground">{L("paperNote")}</p>
          </div>
        </div>
      </section>

      {/* Businesses */}
      <section id="businesses" className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-200/30 blur-[110px]" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Sparkles size={13} /> {L("bizKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("bizTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("bizSub")}</p>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            {businessTypes.map((bt) => (
              <div key={bt.l} className={`card group flex items-center gap-2 p-3 transition duration-300 hover:-translate-y-1 hover:shadow-xl ${bt.glow} sm:gap-3 sm:p-5`}>
                <span className={`grid h-9 w-9 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${bt.grad} text-white shadow-md sm:h-12 sm:w-12`}>
                  <bt.icon size={16} className="sm:h-[21px] sm:w-[21px]" />
                </span>
                <p className="min-w-0 flex-1 break-words text-[0.72rem] font-bold leading-tight sm:text-sm">{L(bt.l)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative overflow-hidden bg-gradient-to-b from-background via-emerald-50/50 to-background dark:via-emerald-950/20">
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Boxes size={13} /> {L("featKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("featTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("featSub", { brand: b })}</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => (
              <div key={f.t} className="card card-gloss group p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-primary/10">
                <span className={`grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br ${featureGrads[i % featureGrads.length]} text-white shadow-md transition group-hover:scale-110`}>
                  <f.icon size={22} />
                </span>
                <h3 className="mt-4 text-base font-bold">{L(f.t)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{L(f.d)}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn btn-primary !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              {L("featCta")} <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>

      {/* Steps */}
      <section id="how" className="relative overflow-hidden bg-[#0a2e25]">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/4 h-72 w-[36rem] rounded-full bg-emerald-400/15 blur-[110px]" />
          <div className="absolute -bottom-24 right-1/4 h-72 w-[36rem] rounded-full bg-teal-300/10 blur-[110px]" />
          <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-100">
              <Smartphone size={13} /> {L("stepsKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{L("stepsTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-emerald-100/70">{L("stepsSub")}</p>
          </div>
          <div className="relative mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-3">
            <div className="pointer-events-none absolute left-[16%] right-[16%] top-10 hidden border-t-2 border-dashed border-white/15 md:block" aria-hidden />
            {steps.map((s) => (
              <div key={s.n} className="relative rounded-3xl border border-white/10 bg-white/[0.06] p-7 text-center backdrop-blur transition hover:bg-white/[0.09]">
                <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-emerald-400 text-xl font-extrabold text-[#0a2e25] shadow-lg shadow-black/20">{s.n}</span>
                <h3 className="mt-5 text-base font-bold text-white">{L(s.t)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-emerald-100/70">{L(s.d)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1400px] px-4 py-14 sm:px-8">
          <div className="grid gap-4 sm:grid-cols-3">
            {trust.map((x) => (
              <div key={x.t} className="group flex items-start gap-4 rounded-3xl border border-border bg-card p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl">
                <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${x.grad} text-white shadow-md transition group-hover:scale-110`}>
                  <x.icon size={21} />
                </span>
                <div>
                  <p className="font-bold">{L(x.t)}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{L(x.d)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="relative overflow-hidden bg-gradient-to-b from-background via-emerald-50/40 to-background dark:via-emerald-950/10">
        <div className="relative mx-auto grid max-w-[1400px] gap-10 px-4 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1fr_1.5fr]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <CheckCircle2 size={13} /> {L("navFaq")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("faqTitleA")}<br />{L("faqTitleB")}</h2>
            <p className="mt-3 max-w-sm text-muted-foreground">{L("faqSub", { brand: b })}</p>
            <Link href="/signup" className="btn btn-primary mt-6 !px-6 !py-3 text-sm shadow-lg shadow-primary/25">
              {L("faqCta")} <ArrowRight size={16} />
            </Link>
          </div>
          <div className="space-y-3">
            {faqs.map((f) => (
              <details key={f.q} className="card group px-6 py-5 transition hover:border-primary/40">
                <summary className="flex cursor-pointer items-center justify-between gap-4 font-bold [&::-webkit-details-marker]:hidden">
                  {L(f.q, { brand: b })}
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-xl leading-none text-white shadow transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{L(f.a, { brand: b })}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-8">
        <div className="relative overflow-hidden rounded-3xl p-10 text-center sm:p-14">
          <div className="absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0d7a5f]" />
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-20 left-1/3 h-72 w-72 rounded-full bg-emerald-400/20 blur-[100px]" />
          </div>
          <h2 className="relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{L("ctaTitle")}</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-emerald-50/80">{L("ctaSub", { brand: b })}</p>
          <Link href="/signup" className="btn relative mt-7 !border-0 !bg-white !px-8 !py-3.5 !text-base !text-[#0a2e25] shadow-xl hover:!bg-emerald-50">
            {L("ctaBtn")} <ArrowRight size={18} />
          </Link>
          <p className="relative mt-4 text-xs text-emerald-100/60">{L("ctaMicro")}</p>
        </div>
      </section>

      <footer className="relative overflow-hidden bg-[#0a2e25] text-emerald-50">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/3 h-64 w-[38rem] rounded-full bg-emerald-400/10 blur-[110px]" />
        </div>
        <div className="relative mx-auto grid max-w-[1400px] gap-10 px-4 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg">
                <ReceiptText size={20} />
              </span>
              <div className="leading-tight">
                <p className="text-lg font-extrabold tracking-tight text-white">{b}</p>
                <p className="text-[0.68rem] font-medium text-emerald-200/60">{brand.tagline}</p>
              </div>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-emerald-100/60">{L("footDesc")}</p>
            <Link href="/signup" className="btn mt-5 !border-0 !bg-white !px-6 !py-2.5 !text-sm !text-[#0a2e25] shadow-lg hover:!bg-emerald-50">
              {L("footStart")} <ArrowRight size={16} />
            </Link>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-200/60">{L("footProduct")}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {footLinks.map(([lk, h]) => (
                <li key={h}><Link href={h} className="text-emerald-100/75 transition hover:text-white">{L(lk)}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-200/60">{L("footMadeFor")}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {madeFor.map((mk) => (
                <li key={mk} className="text-emerald-100/75">{L(mk)}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="relative border-t border-white/10">
          <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-emerald-100/50 sm:flex-row sm:px-8">
            <p>© 2026 {b}. {L("footRights")}</p>
            <p className="flex items-center gap-4">
              <Link href="/terms" className="transition hover:text-emerald-100">{L("footTerms")}</Link>
              <Link href="/privacy" className="transition hover:text-emerald-100">{L("footPrivacy")}</Link>
              <Link href="/support" className="transition hover:text-emerald-100">{L("footSupport")}</Link>
              <Link href="/changelog" className="transition hover:text-emerald-100">{L("footChangelog")}</Link>
              <span className="hidden sm:inline">{L("footTagline")}</span>
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
