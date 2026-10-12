"use client";

import Link from "next/link";
import { ArrowRight, ArrowUpRight, Building2, ShieldCheck, Clock, MapPin, Cpu, Cloud, Code2, Store } from "lucide-react";
import { useLang } from "@/components/lang-provider";
import { brand } from "@/lib/brand";

export default function AboutContent() {
  const { t } = useLang();
  const b = brand.name;

  const services = [
    { icon: Store, t: t("about.s1t"), d: t("about.s1d") },
    { icon: Cpu, t: t("about.s2t"), d: t("about.s2d") },
    { icon: Cloud, t: t("about.s3t"), d: t("about.s3d") },
    { icon: Code2, t: t("about.s4t"), d: t("about.s4d") },
  ];
  const whys = [
    { icon: Building2, t: t("about.w1t"), d: t("about.w1d") },
    { icon: Clock, t: t("about.w2t"), d: t("about.w2d") },
    { icon: MapPin, t: t("about.w3t"), d: t("about.w3d") },
  ];

  return (
    <main>
      {/* Hero */}
      <section className="relative overflow-hidden bg-[#0a1120] text-white">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/3 h-64 w-[38rem] rounded-full bg-[#1e4fa3]/20 blur-[110px]" />
        </div>
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 text-center sm:px-8 sm:py-24">
          <p className="text-xs font-extrabold uppercase tracking-widest text-amber-400">{t("about.eyebrow")}</p>
          <h1 className="mx-auto mt-4 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">{t("about.h1")}</h1>
          <p className="mx-auto mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">{t("about.sub")}</p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="https://techsol.business"
              target="_blank"
              rel="noopener"
              className="btn !border-0 !bg-white !px-6 !py-3 !text-sm !text-[#101a2c] shadow-lg hover:!bg-slate-100"
            >
              {t("about.visitSite")} <ArrowUpRight size={16} />
            </a>
            <Link href="/signup" className="btn !border-white/25 !bg-white/10 !px-6 !py-3 !text-sm !text-white backdrop-blur hover:!bg-white/20">
              {t("about.startFree")} <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </section>

      {/* Who is TechSol */}
      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-8">
        <div className="grid gap-10 md:grid-cols-2 md:items-center">
          <div>
            <h2 className="text-2xl font-extrabold tracking-tight sm:text-3xl">{t("about.whoTitle")}</h2>
            <p className="mt-4 leading-relaxed text-muted-foreground">{t("about.whoP1")}</p>
            <p className="mt-4 leading-relaxed text-muted-foreground">{t("about.whoP2")}</p>
            <a
              href="https://techsol.business"
              target="_blank"
              rel="noopener"
              className="mt-6 inline-flex items-center gap-1.5 font-bold text-primary hover:underline"
            >
              techsol.business <ArrowUpRight size={16} />
            </a>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {services.map((s) => (
              <div key={s.t} className="card p-5">
                <s.icon size={22} className="text-primary" />
                <p className="mt-3 font-extrabold">{s.t}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Why it matters */}
      <section className="border-y border-border bg-muted/40">
        <div className="mx-auto max-w-[1200px] px-4 py-14 sm:px-8">
          <h2 className="text-center text-2xl font-extrabold tracking-tight sm:text-3xl">{t("about.whyTitle")}</h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {whys.map((w) => (
              <div key={w.t} className="card p-6">
                <div className="grid h-11 w-11 place-items-center rounded-xl bg-primary/10 text-primary">
                  <w.icon size={22} />
                </div>
                <p className="mt-4 font-extrabold">{w.t}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{w.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1200px] px-4 py-14 text-center sm:px-8">
        <div className="flex items-center justify-center gap-2 text-primary">
          <ShieldCheck size={20} />
        </div>
        <h2 className="mx-auto mt-3 max-w-xl text-2xl font-extrabold tracking-tight sm:text-3xl">{t("about.ctaTitle")}</h2>
        <p className="mx-auto mt-3 max-w-lg text-muted-foreground">{t("about.ctaSub")}</p>
        <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
          <a
            href="https://techsol.business"
            target="_blank"
            rel="noopener"
            className="btn btn-ghost !border !px-6 !py-3 !text-sm"
          >
            {t("about.visitSite")} <ArrowUpRight size={16} />
          </a>
          <Link href="/signup" className="btn btn-primary !px-6 !py-3 !text-sm">
            {b} — {t("about.startFree")} <ArrowRight size={16} />
          </Link>
        </div>
      </section>
    </main>
  );
}
