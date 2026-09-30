"use client";

import Link from "next/link";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, TrendingUp, Users, Wallet,
  Store, Factory, Stethoscope, Pill, UtensilsCrossed, Briefcase, Truck,
  TriangleAlert, XCircle, BadgeCheck, Play,
} from "lucide-react";
import { ThemeToggle, LangToggle } from "@/components/ui";
import { BrandLockup } from "@/components/brand-logo";
import { Typewriter, type TwPhrase } from "@/components/typewriter";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import { en } from "@/lib/i18n/en";
import { ur } from "@/lib/i18n/ur";

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
  { icon: Boxes, l: "mq0", d: "bd0" },
  { icon: Store, l: "mq1", d: "bd1" },
  { icon: Truck, l: "mq2", d: "bd2" },
  { icon: Pill, l: "mq3", d: "bd3" },
  { icon: Stethoscope, l: "mq4", d: "bd4" },
  { icon: UtensilsCrossed, l: "mq5", d: "bd5" },
  { icon: Briefcase, l: "mq6", d: "bd6" },
  { icon: Factory, l: "mq7", d: "bd7" },
];

const stats = [
  { v: "stat0v", l: "stat0l" },
  { v: "stat1v", l: "stat1l" },
  { v: "stat2v", l: "stat2l" },
  { v: "stat3v", l: "stat3l" },
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
  { t: "tr0t", d: "tr0d", icon: Landmark },
  { t: "tr1t", d: "tr1d", icon: Users },
  { t: "tr2t", d: "tr2d", icon: ShieldCheck },
];

const paperBad = ["pp0", "pp1", "pp2", "pp3"];
const paperGood = ["lp0", "lp1", "lp2", "lp3"];
const madeFor = ["mf0", "mf1", "mf2", "mf3", "mf4", "mf5"];
const footLinks: [string, string][] = [["fl0", "#features"], ["fl1", "#businesses"], ["fl2", "#how"], ["fl3", "#faq"], ["fl4", "/login"]];

export default function LandingContent() {
  const { t } = useLang();
  const b = brand.name;
  const L = (k: string, vars?: Record<string, string | number>) => t(`landing.${k}`, vars);
  const typePhrases: TwPhrase[] = [
    { text: en.landing.tp0 },
    { text: ur.landing?.tp0 ?? en.landing.tp0, rtl: true },
    { text: en.landing.tp1 },
    { text: ur.landing?.tp1 ?? en.landing.tp1, rtl: true },
  ];
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      {/* Nav — floating pill */}
      <header className="fixed inset-x-0 top-3 z-40 px-3 sm:top-4 sm:px-6">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-2 rounded-full border border-white/15 bg-[#071f19]/80 py-1.5 pl-4 pr-1.5 shadow-2xl shadow-black/30 backdrop-blur-xl sm:h-16 sm:pl-5 sm:pr-2">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={b}>
            <BrandLockup markSize={34} wordClass="font-display text-[1.02rem] leading-none text-white hidden min-[420px]:block" tagline dark />
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-semibold text-emerald-50/85 lg:flex">
            <a href="#features" className="transition hover:text-white">{L("navFeatures")}</a>
            <a href="#businesses" className="transition hover:text-white">{L("navBusinesses")}</a>
            <a href="#how" className="transition hover:text-white">{L("navHow")}</a>
            <a href="#faq" className="transition hover:text-white">{L("navFaq")}</a>
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <LangToggle />
            <ThemeToggle />
            <Link href="/login" className="hidden rounded-full px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 md:inline-flex">{L("navLogin")}</Link>
            <Link href="/signup" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[0.8rem] font-extrabold text-[#0a2e25] transition hover:bg-emerald-50 sm:px-5 sm:text-sm">
              {L("navStart")} <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — rounded emerald frame, floating collage */}
      <section className="relative pt-24 sm:pt-28">
        <div className="px-3 sm:px-5">
          <div className="relative mx-auto max-w-[1400px] overflow-hidden rounded-[2rem] sm:rounded-[2.5rem]">
            <div className="absolute inset-0 bg-gradient-to-br from-[#052b21] via-[#0a4634] to-[#062b22]" />
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute -top-24 left-[12%] h-[380px] w-[560px] rounded-full bg-emerald-400/25 blur-[130px]" />
              <div className="absolute bottom-0 right-[8%] h-80 w-80 rounded-full bg-teal-300/20 blur-[110px]" />
              <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
            </div>
            <div className="relative grid items-center gap-14 px-6 pb-16 pt-12 sm:px-10 lg:grid-cols-[1.02fr_0.98fr] lg:gap-6 lg:px-14 lg:pb-24 lg:pt-16">
          <div className="text-center lg:text-left">
            <div className="rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-emerald-50 shadow-sm backdrop-blur">
              <BadgeCheck size={14} className="text-amber-300" />
              {L("heroBadge")}
            </div>
            <h1 className="rise rise-1 font-display mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-[3.6rem]">
              {L("heroTitleA")}{" "}
              <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">{L("heroTitleMid")}</span>
              {L("heroTitleB")}
            </h1>
            <div className="rise rise-1 mt-5 flex min-h-[2.5rem] items-center justify-center gap-2 lg:justify-start" aria-hidden="true">
              <Sparkles size={18} className="shrink-0 text-amber-300" />
              <Typewriter
                phrases={typePhrases}
                caretClassName="text-amber-200"
                className="font-display bg-gradient-to-r from-amber-200 via-emerald-100 to-amber-200 bg-clip-text text-lg font-bold text-transparent sm:text-xl"
              />
            </div>
            <p className="rise rise-2 mt-5 max-w-xl text-base text-emerald-50/80 sm:text-lg lg:mx-0">
              {L("heroSubA")} <span className="font-semibold text-white">{L("heroSubU")}</span> {L("heroSubB", { brand: b })}
            </p>
            <div className="rise rise-3 mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
              <Link href="/signup" className="group inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 text-base font-extrabold text-[#0a2e25] shadow-xl shadow-black/25 transition hover:bg-emerald-50">
                {L("heroCtaStart")} <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5" />
              </Link>
              <a href="#how" className="group inline-flex items-center gap-3 rounded-full border border-white/20 bg-white/10 py-2 pl-2 pr-5 text-sm font-bold text-white backdrop-blur transition hover:bg-white/20">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-[#0a2e25]">
                  <Play size={15} className="ml-0.5 fill-current" />
                </span>
                {L("watchDemo")}
              </a>
            </div>
            <p className="rise rise-4 mt-4 text-xs text-emerald-100/60">{L("heroMicro")}</p>
          </div>

          {/* Collage — dashboard centerpiece + floating glass cards */}
          <div className="rise rise-2 relative mx-auto w-full max-w-[500px]">
            <div className="pointer-events-none absolute -inset-8 rounded-[2.5rem] bg-emerald-400/15 blur-3xl" />
            {/* P&L sparkline card */}
            <div className="floaty absolute -top-9 -left-4 z-10 hidden w-52 rounded-2xl border border-white/15 bg-white/10 p-4 shadow-xl backdrop-blur-xl sm:block" style={{ animationDelay: "-2s" }} aria-hidden="true">
              <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-emerald-100/70">{L("fcPlT")}</p>
              <p className="font-display mt-1 text-2xl font-extrabold tracking-tight text-white">Rs 1,84,500</p>
              <svg viewBox="0 0 120 36" className="mt-2 h-9 w-full" aria-hidden="true">
                <polyline points="0,28 15,24 30,26 45,18 60,21 75,13 90,16 105,8 120,10" fill="none" stroke="#6ee7b7" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="mt-1 text-[0.7rem] font-bold text-emerald-300">{L("fcPlD")}</p>
            </div>
            {/* New invoice card */}
            <div className="floaty absolute -top-7 -right-4 z-10 hidden w-56 rounded-2xl border border-white/15 bg-white/10 p-4 shadow-xl backdrop-blur-xl md:block" style={{ animationDelay: "-4.2s" }} aria-hidden="true">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-white">{L("fcInvT")}</p>
                <span className="rounded-md bg-white/15 px-2 py-0.5 text-[0.65rem] font-bold text-emerald-100">INV-0104</span>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-xl bg-black/25 px-3 py-2.5">
                <span className="text-sm font-bold text-white/90">Rs 25,000</span>
                <span className="h-4 w-px animate-pulse bg-emerald-300" />
              </div>
              <div className="mt-3 rounded-full bg-white py-2 text-center text-xs font-extrabold text-[#0a2e25]">{L("fcInvB")}</div>
            </div>
            {/* Payment received toasts */}
            <div className="absolute top-[36%] -right-7 z-10 hidden flex-col gap-2.5 lg:flex" aria-hidden="true">
              {[{ n: "fcRecN0", init: "AT", d: "-1.2s" }, { n: "fcRecN1", init: "SK", d: "-3.4s" }].map((r) => (
                <div key={r.n} className="floaty flex items-center gap-2.5 rounded-2xl border border-white/15 bg-white/10 py-2.5 pl-2.5 pr-4 shadow-lg backdrop-blur-xl" style={{ animationDelay: r.d }}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-amber-300 to-emerald-400 text-[0.7rem] font-extrabold text-[#0a2e25]">{r.init}</span>
                  <span>
                    <span className="block text-[0.72rem] font-extrabold text-white">Rs 10,000</span>
                    <span className="block text-[0.65rem] text-emerald-100/75">{L("fcRecT")} · {L("fcRecD", { name: L(r.n) })}</span>
                  </span>
                </div>
              ))}
            </div>
            {/* Low stock glass card */}
            <div className="floaty absolute -bottom-9 -left-5 z-10 hidden items-center gap-3 rounded-2xl border border-white/15 bg-white/10 p-3 pr-5 shadow-xl backdrop-blur-xl md:flex" style={{ animationDelay: "-5.6s" }} aria-hidden="true">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-amber-400/20 text-amber-300">
                <TriangleAlert size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-white">{L("mockAlertTitle")}</span>
                <span className="block text-[0.7rem] text-emerald-100/70">{L("mockAlertSub")}</span>
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
          </div>
        </div>
        {/* Business-type marquee — solid band, crisp text */}
        <div className="relative z-10 mt-4 border-y border-white/10 bg-[#082a21]">
          <div className="overflow-hidden py-5 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
            <div className="animate-marquee flex w-max items-center gap-12 pr-12">
              {[...businessTypes, ...businessTypes].map((bt, i) => (
                <span key={i} className="flex items-center gap-2.5 text-sm font-bold tracking-wide text-white">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10">
                    <bt.icon size={15} className="text-emerald-300" />
                  </span>
                  {L(bt.l)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Paper vs LedgerProSolution */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-emerald-200/40 blur-[110px] dark:bg-emerald-400/10" />
          <div className="absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-amber-100/60 blur-[110px] dark:bg-amber-400/10" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-500/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-amber-700 dark:text-amber-300">
              <TriangleAlert size={13} /> {L("paperKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("paperTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("paperSub")}</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-5xl gap-5 md:grid-cols-2 md:gap-8">
            <div className="rounded-3xl border border-border bg-card/80 p-8 shadow-sm backdrop-blur transition hover:shadow-md sm:p-10">
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{L("paperColT")}</p>
              <ul className="mt-6 space-y-4">
                {paperBad.map((k) => (
                  <li key={k} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <XCircle size={17} className="mt-0.5 shrink-0 text-red-400" /> {L(k)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 p-[2px] shadow-xl shadow-emerald-500/20 transition hover:shadow-2xl hover:shadow-emerald-500/30">
              <div className="relative h-full rounded-[calc(1.5rem-2px)] bg-card p-8 sm:p-10">
                <span className="absolute -top-3.5 left-8 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wider text-white shadow-md">{L("recommended")}</span>
                <p className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-sm font-extrabold uppercase tracking-wider text-transparent">{b}</p>
                <ul className="mt-6 space-y-4">
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

      {/* Stats band */}
      <section className="relative border-y border-border/60 bg-muted/40">
        <div className="mx-auto grid max-w-[1400px] grid-cols-2 gap-6 px-4 py-10 sm:px-8 sm:py-12 lg:grid-cols-4 lg:px-12">
          {stats.map((s) => (
            <div key={s.v} className="text-center">
              <p className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-3xl font-extrabold tracking-tight text-transparent sm:text-4xl">{L(s.v)}</p>
              <p className="mt-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:text-sm sm:normal-case sm:tracking-normal">{L(s.l)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Businesses */}
      <section id="businesses" className="relative overflow-hidden border-b border-border/40 bg-gradient-to-b from-emerald-50/70 via-emerald-50/30 to-background dark:from-emerald-950/25 dark:via-emerald-950/10 dark:to-background">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-200/40 blur-[110px] dark:bg-emerald-400/10" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Sparkles size={13} /> {L("bizKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("bizTitle")}</h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{L("bizSub")}</p>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
            {businessTypes.map((bt) => (
              <div key={bt.l} className="card group p-4 transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/10 sm:p-6">
                <span className="grid h-11 w-11 place-items-center rounded-2xl bg-primary/10 text-primary transition group-hover:scale-110 group-hover:bg-primary group-hover:text-white sm:h-12 sm:w-12">
                  <bt.icon size={20} />
                </span>
                <p className="mt-3.5 text-sm font-bold sm:text-base">{L(bt.l)}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground sm:text-[0.83rem]">{L(bt.d)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Boxes size={13} /> {L("featKicker")}
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("featTitle")}</h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{L("featSub", { brand: b })}</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
            {features.map((f) => (
              <div key={f.t} className="card group p-6 transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/10 sm:p-7">
                <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary transition group-hover:scale-110 group-hover:bg-primary group-hover:text-white">
                  <f.icon size={22} />
                </span>
                <h3 className="mt-4 text-base font-bold sm:text-lg">{L(f.t)}</h3>
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
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24 lg:px-12">
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
              <div key={s.n} className="relative rounded-3xl border border-white/10 bg-white/[0.06] p-7 text-center backdrop-blur transition hover:bg-white/[0.09] sm:p-8">
                <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-amber-400 text-xl font-extrabold text-emerald-950 shadow-lg shadow-black/25">{s.n}</span>
                <h3 className="mt-5 text-base font-bold text-white sm:text-lg">{L(s.t)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-emerald-100/70">{L(s.d)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1400px] px-4 py-14 sm:px-8 lg:px-12">
          <div className="grid gap-4 sm:grid-cols-3">
            {trust.map((x) => (
              <div key={x.t} className="group flex items-start gap-4 rounded-3xl border border-border bg-card p-6 transition duration-300 hover:-translate-y-1 hover:border-primary/40 hover:shadow-xl hover:shadow-primary/10 sm:p-7">
                <span className="grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary transition group-hover:scale-110 group-hover:bg-primary group-hover:text-white">
                  <x.icon size={21} />
                </span>
                <div>
                  <p className="font-bold">{L(x.t)}</p>
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{L(x.d)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" className="relative overflow-hidden bg-gradient-to-b from-background via-emerald-50/40 to-background dark:via-emerald-950/10">
        <div className="relative mx-auto grid max-w-[1400px] gap-10 px-4 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1fr_1.5fr] lg:px-12">
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
      <section className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-8 lg:px-12">
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
            <BrandLockup markSize={40} wordClass="text-lg leading-tight text-white" tagline dark />
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
