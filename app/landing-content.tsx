"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, TrendingUp, Users, Wallet,
  Store, Factory, Stethoscope, Pill, UtensilsCrossed, Briefcase, Truck,
  TriangleAlert, XCircle, BadgeCheck, Play, LayoutGrid,
} from "lucide-react";
import { ThemeToggle, LangToggle } from "@/components/ui";
import { BrandLockup } from "@/components/brand-logo";
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
  { icon: Boxes, l: "mq0", d: "bd0" },
  { icon: Store, l: "mq1", d: "bd1" },
  { icon: Truck, l: "mq2", d: "bd2" },
  { icon: Pill, l: "mq3", d: "bd3" },
  { icon: Stethoscope, l: "mq4", d: "bd4" },
  { icon: UtensilsCrossed, l: "mq5", d: "bd5" },
  { icon: Briefcase, l: "mq6", d: "bd6" },
  { icon: Factory, l: "mq7", d: "bd7" },
  { icon: LayoutGrid, l: "mq8", d: "bd8" },
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

const paperBad = ["pp0", "pp1", "pp2", "pp3", "pp4", "pp5"];
const paperGood = ["lp0", "lp1", "lp2", "lp3", "lp4", "lp5"];
const madeFor = ["mf0", "mf1", "mf2", "mf3", "mf4", "mf5", "mf6", "mf7"];
const freeFeatures = ["ff0", "ff1", "ff2", "ff3", "ff4", "ff5"];
const proFeatures = ["pf0", "pf1", "pf2", "pf3", "pf4", "pf5", "pf6"];
const footLinks: [string, string][] = [["fl0", "#features"], ["fl1", "#businesses"], ["fl2", "#how"], ["fl5", "#pricing"], ["fl3", "#faq"], ["fl4", "/login"]];

export default function LandingContent() {
  const { t } = useLang();
  const b = brand.name;
  const [billing, setBilling] = useState<"m" | "y">("m");
  const [showStickyCta, setShowStickyCta] = useState(false);
  const L = (k: string, vars?: Record<string, string | number>) => t(`landing.${k}`, vars);
  useEffect(() => {
    const onScroll = () => setShowStickyCta(window.scrollY > 650);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      {/* Nav — floating pill, deep ink navy */}
      <header className="fixed inset-x-0 top-3 z-40 px-3 sm:top-4 sm:px-6">
        <div className="mx-auto flex h-14 max-w-[1600px] items-center justify-between gap-2 rounded-full border border-white/15 bg-[#101a2c]/85 py-1.5 pe-1.5 ps-4 shadow-2xl shadow-black/30 backdrop-blur-xl sm:h-16 sm:pe-2 sm:ps-5">
          <Link href="/" className="flex min-w-0 items-center gap-2.5" aria-label={b}>
            <BrandLockup markSize={38} wordClass="font-display text-[1.02rem] leading-none text-white hidden min-[420px]:block" dark />
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-semibold text-white/80 lg:flex">
            <a href="#features" className="transition hover:text-white">{L("navFeatures")}</a>
            <a href="#businesses" className="transition hover:text-white">{L("navBusinesses")}</a>
            <a href="#how" className="transition hover:text-white">{L("navHow")}</a>
            <a href="#pricing" className="transition hover:text-white">{L("navPricing")}</a>
            <a href="#faq" className="transition hover:text-white">{L("navFaq")}</a>
          </nav>
          <div className="flex items-center gap-1 sm:gap-2">
            <LangToggle />
            <ThemeToggle />
            <Link href="/login" className="hidden rounded-full px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 md:inline-flex">{L("navLogin")}</Link>
            <Link href="/signup" className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-white px-4 py-2 text-[0.8rem] font-extrabold text-[#101a2c] transition hover:bg-slate-100 sm:px-5 sm:text-sm">
              {L("navStart")} <ArrowRight size={15} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — deep ink frame, floating collage */}
      <section className="relative pt-20 sm:pt-24">
        <div className="px-3 sm:px-5">
          <div className="relative mx-auto max-w-[1600px] overflow-hidden rounded-[2rem] sm:rounded-[2.5rem]">
            <div className="absolute inset-0 bg-[#101a2c]" />
            <div className="pointer-events-none absolute inset-0">
              <div className="absolute -top-24 left-[12%] h-[380px] w-[560px] rounded-full bg-[#1e4fa3]/40 blur-[130px]" />
              <div className="absolute bottom-0 right-[8%] h-80 w-80 rounded-full bg-[#f0b73f]/15 blur-[110px]" />
              <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
            </div>
            <div className="relative grid items-center gap-10 px-6 pb-10 pt-10 sm:px-10 lg:grid-cols-[1.02fr_0.98fr] lg:gap-8 lg:px-12 lg:pb-12 lg:pt-12">
          <div className="text-center lg:text-start">
            <div className="rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-white shadow-sm backdrop-blur">
              <BadgeCheck size={14} className="text-[#f0b73f]" />
              {L("heroBadge")}
            </div>
            <h1 className="rise rise-1 font-display mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-[3.6rem]">
              {L("heroTitleA")}{" "}
              <span className="text-accent">{L("heroTitleMid")}</span>{" "}
              {L("heroTitleB")}
            </h1>
            <p className="rise rise-2 mt-5 max-w-xl text-base text-white/85 sm:text-lg lg:mx-0">
              {L("heroSubA")} <span className="font-semibold text-white">{L("heroSubU")}</span> {L("heroSubB", { brand: b })}
            </p>
            <div className="rise rise-3 mt-8 flex flex-wrap items-center justify-center gap-4 lg:justify-start">
              <Link href="/signup" className="group inline-flex items-center gap-2 rounded-full bg-white px-7 py-3.5 text-base font-extrabold text-[#101a2c] shadow-xl shadow-black/25 transition hover:bg-slate-100">
                {L("heroCtaStart")} <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
              </Link>
              <a href="#how" className="group inline-flex items-center gap-3 rounded-full border border-white/20 bg-white/10 py-2 pe-5 ps-2 text-sm font-bold text-white backdrop-blur transition hover:bg-white/20">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-white text-[#101a2c]">
                  <Play size={15} className="ms-0.5 fill-current" />
                </span>
                {L("watchDemo")}
              </a>
            </div>
            <p className="rise rise-4 mt-4 text-xs text-white/70">{L("heroMicro")}</p>
          </div>

          {/* Collage — dashboard centerpiece + floating cards */}
          <div className="rise rise-2 relative mx-auto w-full max-w-[520px] lg:h-[520px]">
            <div className="pointer-events-none absolute -inset-8 rounded-[2.5rem] bg-[#1e4fa3]/25 blur-3xl" aria-hidden="true" />
            {/* Dashboard — in flow on small screens, centered stage on lg */}
            <div className="relative lg:absolute lg:left-1/2 lg:top-1/2 lg:w-[400px] lg:-translate-x-1/2 lg:-translate-y-1/2">
              <div className="floaty card card-gloss p-5 text-start shadow-2xl sm:p-7">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{L("mockToday")}</p>
                    <p className="mt-1 text-3xl font-extrabold tracking-tight">Rs 1,84,500</p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5">
                    <span className="badge bg-primary-soft text-primary"><TrendingUp size={13} /> {L("mockWeek")}</span>
                    <span className="rounded-md bg-muted px-2 py-0.5 text-[0.65rem] font-bold uppercase tracking-wide text-muted-foreground">{L("mockSample")}</span>
                  </div>
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
            {/* Mobile floaters — compact grid so nothing is hidden below lg */}
            <div className="mt-6 grid grid-cols-2 gap-3 lg:hidden" aria-hidden="true">
              <div className="floaty rounded-2xl bg-white p-4 text-start shadow-xl shadow-black/20">
                <p className="text-[0.68rem] font-bold uppercase tracking-wider text-slate-400">{L("fcPlT")}</p>
                <p className="font-display mt-1 text-xl font-extrabold tracking-tight text-slate-900">Rs 1,84,500</p>
                <svg viewBox="0 0 120 36" className="mt-2 h-8 w-full" aria-hidden="true">
                  <polyline points="0,28 15,24 30,26 45,18 60,21 75,13 90,16 105,8 120,10" fill="none" stroke="#1e4fa3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </div>
              <div className="floaty rounded-2xl bg-white p-4 text-start shadow-xl shadow-black/20" style={{ animationDelay: "-3s" }}>
                <div className="flex items-center justify-between">
                  <p className="text-xs font-bold text-slate-900">{L("fcInvT")}</p>
                  <span className="rounded-md bg-primary-soft px-2 py-0.5 text-[0.65rem] font-bold text-primary">INV-0104</span>
                </div>
                <p className="mt-2.5 text-lg font-extrabold text-slate-900">Rs 25,000</p>
                <div className="mt-2.5 rounded-full bg-primary py-2 text-center text-xs font-extrabold text-primary-foreground">{L("fcInvB")}</div>
              </div>
              <div className="floaty flex items-center gap-2.5 rounded-2xl bg-white p-3 text-start shadow-xl shadow-black/20" style={{ animationDelay: "-1.5s" }}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#f0b73f] to-[#b45309] text-[0.7rem] font-extrabold text-[#231600]">AT</span>
                <span>
                  <span className="block text-[0.72rem] font-extrabold text-slate-900">Rs 10,000</span>
                  <span className="block text-[0.65rem] font-medium text-slate-500">{L("fcRecT")} · {L("fcRecD", { name: L("fcRecN0") })}</span>
                </span>
              </div>
              <div className="floaty flex items-center gap-2.5 rounded-2xl bg-white p-3 text-start shadow-xl shadow-black/20" style={{ animationDelay: "-5s" }}>
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[#fbeed7] text-[#b45309]">
                  <TriangleAlert size={18} />
                </span>
                <span>
                  <span className="block text-[0.72rem] font-bold text-slate-900">{L("mockAlertTitle")}</span>
                  <span className="block text-[0.65rem] text-slate-500">{L("mockAlertSub")}</span>
                </span>
              </div>
            </div>
            {/* P&L sparkline card — top-left zone, solid for readability (lg) */}
            <div className="floaty absolute left-0 top-0 z-10 hidden w-44 rounded-2xl bg-white p-4 text-start shadow-2xl shadow-black/25 lg:block" style={{ animationDelay: "-2s" }} aria-hidden="true">
              <p className="text-[0.68rem] font-bold uppercase tracking-wider text-slate-400">{L("fcPlT")}</p>
              <p className="font-display mt-1 text-[1.4rem] font-extrabold tracking-tight text-slate-900">Rs 1,84,500</p>
              <svg viewBox="0 0 120 36" className="mt-2 h-9 w-full" aria-hidden="true">
                <polyline points="0,28 15,24 30,26 45,18 60,21 75,13 90,16 105,8 120,10" fill="none" stroke="#1e4fa3" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <p className="mt-1 text-[0.7rem] font-bold text-[#1e4fa3]">{L("fcPlD")}</p>
            </div>
            {/* New invoice card — top-right zone (lg) */}
            <div className="floaty absolute right-0 top-8 z-10 hidden w-48 rounded-2xl bg-white p-4 text-start shadow-2xl shadow-black/25 lg:block" style={{ animationDelay: "-4.2s" }} aria-hidden="true">
              <div className="flex items-center justify-between">
                <p className="text-xs font-bold text-slate-900">{L("fcInvT")}</p>
                <span className="rounded-md bg-primary-soft px-2 py-0.5 text-[0.65rem] font-bold text-primary">INV-0104</span>
              </div>
              <div className="mt-3 flex items-center justify-between rounded-xl bg-slate-100 px-3 py-2.5">
                <span className="text-sm font-extrabold text-slate-900">Rs 25,000</span>
                <span className="h-4 w-px animate-pulse bg-primary" />
              </div>
              <div className="mt-3 rounded-full bg-primary py-2 text-center text-xs font-extrabold text-primary-foreground">{L("fcInvB")}</div>
            </div>
            {/* Payment received toasts — bottom-right zone (lg) */}
            <div className="absolute bottom-16 right-0 z-10 hidden flex-col gap-2.5 lg:flex" aria-hidden="true">
              {[{ n: "fcRecN0", init: "AT", d: "-1.2s" }, { n: "fcRecN1", init: "SK", d: "-3.4s" }].map((r) => (
                <div key={r.n} className="floaty flex items-center gap-2.5 rounded-2xl bg-white py-2.5 pe-4 ps-2.5 text-start shadow-2xl shadow-black/25" style={{ animationDelay: r.d }}>
                  <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-[#f0b73f] to-[#b45309] text-[0.7rem] font-extrabold text-[#231600]">{r.init}</span>
                  <span>
                    <span className="block text-[0.72rem] font-extrabold text-slate-900">Rs 10,000</span>
                    <span className="block text-[0.65rem] font-medium text-slate-500">{L("fcRecT")} · {L("fcRecD", { name: L(r.n) })}</span>
                  </span>
                </div>
              ))}
            </div>
            {/* Low stock card — bottom-left zone (lg) */}
            <div className="floaty absolute bottom-0 left-2 z-10 hidden items-center gap-3 rounded-2xl bg-white p-3 pe-5 text-start shadow-2xl shadow-black/25 lg:flex" style={{ animationDelay: "-5.6s" }} aria-hidden="true">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-[#fbeed7] text-[#b45309]">
                <TriangleAlert size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-900">{L("mockAlertTitle")}</span>
                <span className="block text-[0.7rem] text-slate-500">{L("mockAlertSub")}</span>
              </span>
            </div>
          </div>
            </div>
          </div>
        </div>
        {/* Business-type marquee — solid ink band, crisp text */}
        <div className="relative z-10 mt-4 border-y border-white/10 bg-[#0a1120]">
          <div className="overflow-hidden py-5 [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
            <div className="animate-marquee flex w-max items-center gap-12 pr-12">
              {[...businessTypes, ...businessTypes].map((bt, i) => (
                <span key={i} className="flex items-center gap-2.5 text-sm font-bold tracking-wide text-white">
                  <span className="grid h-8 w-8 place-items-center rounded-lg bg-white/10">
                    <bt.icon size={15} className="text-[#f0b73f]" />
                  </span>
                  {L(bt.l)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Paper vs LedgerProSolution — warm paper tint, thematic */}
      <section className="relative overflow-hidden bg-[#f7f4ec] dark:bg-white/[0.03]">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-primary/10 blur-[110px] dark:bg-primary/20" />
          <div className="absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-[#f0b73f]/15 blur-[110px]" />
        </div>
        <div className="relative mx-auto max-w-[1200px] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-accent-soft px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-accent">
              <TriangleAlert size={13} /> {L("paperKicker")}
            </span>
            <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("paperTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">{L("paperSub")}</p>
          </div>
          <div className="mx-auto mt-8 grid max-w-5xl gap-5 md:grid-cols-2 md:gap-8">
            <div className="rounded-3xl border border-border bg-card/80 p-6 shadow-sm backdrop-blur transition hover:shadow-md sm:p-8">
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">{L("paperColT")}</p>
              <ul className="mt-6 space-y-4">
                {paperBad.map((k) => (
                  <li key={k} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <XCircle size={17} className="mt-0.5 shrink-0 text-danger" /> {L(k)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl border-2 border-primary bg-card p-6 shadow-xl shadow-primary/15 transition hover:shadow-2xl sm:p-8">
              <div className="relative h-full pt-5">
                <span className="absolute -top-3.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-accent px-3.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wider text-accent-foreground shadow-md">{L("recommended")}</span>
                <p className="text-sm font-extrabold uppercase tracking-wider text-primary">{b}</p>
                <ul className="mt-6 space-y-4">
                  {paperGood.map((k) => (
                    <li key={k} className="flex items-start gap-2.5 text-sm font-medium">
                      <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-primary" /> {L(k)}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn btn-primary group !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              {L("paperCta")} <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
            </Link>
            <p className="mt-3 text-xs text-muted-foreground">{L("paperNote")}</p>
          </div>
        </div>
      </section>

      {/* Stats band */}
      <section className="relative border-y border-border/60 bg-muted/40">
        <div className="mx-auto grid max-w-[1200px] grid-cols-2 gap-6 px-4 py-8 sm:px-8 sm:py-10 lg:grid-cols-4 lg:px-12">
          {stats.map((s) => (
            <div key={s.v} className="text-center">
              <p className="font-display text-3xl font-extrabold tracking-tight text-primary sm:text-4xl">{L(s.v)}</p>
              <p className="mt-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground sm:text-sm sm:normal-case sm:tracking-normal">{L(s.l)}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Businesses */}
      <section id="businesses" className="relative overflow-hidden border-b border-border/40 bg-gradient-to-b from-primary-soft/50 via-primary-soft/20 to-background dark:from-primary-soft/30 dark:via-primary-soft/10 dark:to-background">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-primary/15 blur-[110px] dark:bg-primary/25" />
        </div>
        <div className="relative mx-auto max-w-[1200px] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
          <div className="max-w-2xl">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Sparkles size={13} /> {L("bizKicker")}
            </span>
            <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("bizTitle")}</h2>
            <p className="mt-3 text-muted-foreground">{L("bizSub")}</p>
          </div>
          <div className="mt-8 grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
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
        <div className="relative mx-auto max-w-[1200px] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Boxes size={13} /> {L("featKicker")}
            </span>
            <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("featTitle")}</h2>
            <p className="mx-auto mt-3 max-w-2xl text-muted-foreground">{L("featSub", { brand: b })}</p>
          </div>
          <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-5">
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
            <Link href="/signup" className="btn btn-primary group !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              {L("featCta")} <ArrowRight size={18} className="transition-transform group-hover:translate-x-0.5 rtl:group-hover:-translate-x-0.5" />
            </Link>
          </div>
        </div>
      </section>

      {/* Steps */}
      <section id="how" className="relative overflow-hidden bg-[#101a2c]">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/4 h-72 w-[36rem] rounded-full bg-[#1e4fa3]/25 blur-[110px]" />
          <div className="absolute -bottom-24 right-1/4 h-72 w-[36rem] rounded-full bg-[#f0b73f]/10 blur-[110px]" />
          <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        </div>
        <div className="relative mx-auto max-w-[1200px] px-4 py-12 sm:px-8 sm:py-16 lg:px-12">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-white/90">
              <Smartphone size={13} /> {L("stepsKicker")}
            </span>
            <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{L("stepsTitle")}</h2>
            <p className="mx-auto mt-3 max-w-xl text-white/75">{L("stepsSub")}</p>
          </div>
          <div className="relative mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-3">
            <div className="pointer-events-none absolute left-[16%] right-[16%] top-10 hidden border-t-2 border-dashed border-white/15 md:block" aria-hidden />
            {steps.map((s) => (
              <div key={s.n} className="relative rounded-3xl border border-white/10 bg-white/[0.06] p-7 text-center backdrop-blur transition hover:bg-white/[0.09] sm:p-8">
                <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#f0b73f] text-xl font-extrabold text-[#231600] shadow-lg shadow-black/25">{s.n}</span>
                <h3 className="mt-5 text-base font-bold text-white sm:text-lg">{L(s.t)}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-white/75">{L(s.d)}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="relative overflow-hidden bg-muted/40">
        <div className="relative mx-auto max-w-[1200px] px-4 py-10 sm:px-8 lg:px-12">
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

      {/* Pricing — soft gold-tinted band so the PRO card glows */}
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
          <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-2">
            {/* Free */}
            <div className="card flex flex-col p-7 sm:p-8">
              <p className="text-sm font-extrabold uppercase tracking-wider text-muted-foreground">{L("planFree")}</p>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-extrabold tracking-tight">{L("freePrice")}</span>
                <span className="text-sm text-muted-foreground">{L("freePer")}</span>
              </p>
              <ul className="mt-6 flex-1 space-y-3">
                {freeFeatures.map((f) => (
                  <li key={f} className="flex items-start gap-2.5 text-sm">
                    <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-primary" />
                    <span>{L(f)}</span>
                  </li>
                ))}
              </ul>
              <Link href="/signup" className="btn btn-ghost mt-7 w-full !py-3 text-sm">
                {L("ctaFree")} <ArrowRight size={16} />
              </Link>
            </div>
            {/* PRO */}
            <div className="relative flex flex-col overflow-hidden rounded-3xl border-2 border-[#f0b73f] bg-[#101a2c] p-7 shadow-2xl shadow-[#f0b73f]/15 sm:p-8">
              <span className="absolute end-5 top-5 rounded-full bg-[#f0b73f] px-3 py-1 text-[0.7rem] font-extrabold uppercase tracking-wide text-[#231600]">{L("proTag")}</span>
              <p className="text-sm font-extrabold uppercase tracking-wider text-[#f0b73f]">{L("planPro")}</p>
              <p className="mt-3 flex items-baseline gap-1">
                <span className="font-display text-4xl font-extrabold tracking-tight text-white">{billing === "m" ? L("proMonthlyPrice") : L("proYearlyPrice")}</span>
                <span className="text-sm text-white/60">{billing === "m" ? L("perMonth") : L("perYear")}</span>
              </p>
              <p className="mt-1 text-xs text-white/50">{billing === "y" ? L("billedYearly") : "\u00A0"}</p>
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

      {/* FAQ */}
      <section id="faq" className="relative overflow-hidden bg-gradient-to-b from-background via-primary-soft/40 to-background dark:via-primary-soft/20">
        <div className="relative mx-auto grid max-w-[1200px] gap-10 px-4 py-12 sm:px-8 sm:py-16 lg:grid-cols-[1fr_1.5fr] lg:px-12">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <CheckCircle2 size={13} /> {L("navFaq")}
            </span>
            <h2 className="font-display mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">{L("faqTitleA")}<br />{L("faqTitleB")}</h2>
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
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-primary text-xl leading-none text-primary-foreground shadow transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{L(f.a, { brand: b })}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-4 pb-14 sm:px-8 lg:px-12">
        <div className="relative overflow-hidden rounded-3xl bg-[#101a2c] p-8 text-center sm:p-12">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-20 left-1/3 h-72 w-72 rounded-full bg-[#1e4fa3]/30 blur-[100px]" />
            <div className="absolute -bottom-24 right-1/4 h-64 w-64 rounded-full bg-[#f0b73f]/10 blur-[100px]" />
          </div>
          <h2 className="font-display relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">{L("ctaTitle")}</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-white/80">{L("ctaSub", { brand: b })}</p>
          <Link href="/signup" className="btn relative mt-7 !border-0 !bg-white !px-8 !py-3.5 !text-base !text-[#101a2c] shadow-xl hover:!bg-slate-100">
            {L("ctaBtn")} <ArrowRight size={18} />
          </Link>
          <p className="relative mt-4 text-xs text-white/70">{L("ctaMicro")}</p>
        </div>
      </section>

      <footer className="relative overflow-hidden bg-[#0a1120] text-white">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/3 h-64 w-[38rem] rounded-full bg-[#1e4fa3]/15 blur-[110px]" />
        </div>
        <div className="relative mx-auto grid max-w-[1200px] gap-10 px-4 py-10 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <BrandLockup markSize={40} wordClass="text-lg leading-tight text-white" tagline dark />
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-white/65">{L("footDesc")}</p>
            <Link href="/signup" className="btn mt-5 !border-0 !bg-white !px-6 !py-2.5 !text-sm !text-[#101a2c] shadow-lg hover:!bg-slate-100">
              {L("footStart")} <ArrowRight size={16} />
            </Link>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-white/50">{L("footProduct")}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {footLinks.map(([lk, h]) => (
                <li key={h}><Link href={h} className="text-white/75 transition hover:text-white">{L(lk)}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-white/50">{L("footMadeFor")}</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {madeFor.map((mk) => (
                <li key={mk} className="text-white/75">{L(mk)}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="relative border-t border-white/10">
          <div className="mx-auto flex max-w-[1200px] flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-white/70 sm:flex-row sm:px-8">
            <p>© 2026 {b}. {L("footRights")}</p>
            <p className="flex items-center gap-4">
              <Link href="/terms" className="transition hover:text-white">{L("footTerms")}</Link>
              <Link href="/privacy" className="transition hover:text-white">{L("footPrivacy")}</Link>
              <Link href="/support" className="transition hover:text-white">{L("footSupport")}</Link>
              <Link href="/changelog" className="transition hover:text-white">{L("footChangelog")}</Link>
              <span className="hidden sm:inline">{L("footTagline")}</span>
            </p>
          </div>
        </div>
      </footer>

      {/* Sticky mobile CTA — appears after scrolling past the hero */}
      <div
        aria-hidden={!showStickyCta}
        className={`fixed inset-x-3 bottom-3 z-40 transition-all duration-300 md:hidden ${showStickyCta ? "translate-y-0 opacity-100" : "pointer-events-none translate-y-6 opacity-0"}`}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="flex items-center justify-between gap-3 rounded-2xl border border-white/15 bg-[#101a2c]/95 py-2.5 pe-2.5 ps-4 shadow-2xl shadow-black/40 backdrop-blur-xl">
          <p className="min-w-0 flex-1 truncate text-xs font-bold text-white">{L("stickyNote")}</p>
          <Link href="/signup" className="inline-flex shrink-0 items-center gap-1.5 rounded-xl bg-[#f0b73f] px-4 py-2.5 text-sm font-extrabold text-[#231600] shadow-lg transition active:scale-95">
            {L("ctaFree")} <ArrowRight size={15} />
          </Link>
        </div>
      </div>
    </div>
  );
}
