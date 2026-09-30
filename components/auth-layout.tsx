"use client";

import Link from "next/link";
import { FileText, Wallet, BarChart3, ShieldCheck, BadgeCheck, TrendingUp, HandCoins, TriangleAlert } from "lucide-react";
import { ThemeToggle, LangToggle } from "./ui";
import { BrandLockup, BrandMark } from "./brand-logo";
import { Typewriter, type TwPhrase } from "./typewriter";
import { brand } from "@/lib/brand";
import { useLang } from "./lang-provider";
import { en } from "@/lib/i18n/en";
import { ur } from "@/lib/i18n/ur";
import type { ReactNode } from "react";

const points = [
  { icon: FileText, t: "p0t", d: "p0d" },
  { icon: Wallet, t: "p1t", d: "p1d" },
  { icon: BarChart3, t: "p2t", d: "p2d" },
  { icon: ShieldCheck, t: "p3t", d: "p3d" },
];

const bars = [35, 55, 42, 68, 56, 82, 100];

/**
 * Immersive auth shell — one full-bleed deep-emerald stage (no split panels),
 * bilingual typewriter headline, glass feature pills. Always renders in the
 * dark brand theme so the experience is identical in both app themes.
 */
export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useLang();
  const L = (k: string, vars?: Record<string, string | number>) => t(`authlayout.${k}`, vars);
  const phrases: TwPhrase[] = [
    { text: en.authlayout.tp0 },
    { text: ur.authlayout?.tp0 ?? en.authlayout.tp0, rtl: true },
    { text: en.authlayout.tp1 },
    { text: ur.authlayout?.tp1 ?? en.authlayout.tp1, rtl: true },
  ];
  return (
    <div className="dark relative min-h-screen overflow-hidden bg-[#071f19] text-white">
      {/* Immersive background — single continuous stage */}
      <div className="absolute inset-0 bg-gradient-to-b from-[#071f19] via-[#0a2e25] to-[#0c3f30]" aria-hidden="true" />
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="orb-drift absolute -top-32 left-1/2 h-[30rem] w-[46rem] -translate-x-1/2 rounded-full bg-emerald-400/15 blur-[130px]" />
        <div className="orb-drift-rev absolute top-1/3 -left-40 h-96 w-96 rounded-full bg-teal-300/10 blur-[110px]" />
        <div className="orb-drift absolute bottom-0 -right-32 h-[26rem] w-[26rem] rounded-full bg-emerald-500/10 blur-[120px]" />
        <div
          className="absolute inset-0 opacity-[0.05]"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "30px 30px" }}
        />
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-emerald-300/50 to-transparent" />
      </div>

      {/* Top bar */}
      <header className="relative z-10 flex h-16 items-center justify-between px-4 sm:px-8">
        <Link href="/" aria-label={brand.name}>
          <BrandLockup markSize={34} wordClass="font-display text-[1.02rem] leading-none text-white" tagline dark />
        </Link>
        <div className="flex items-center gap-2">
          <LangToggle />
          <ThemeToggle />
        </div>
      </header>

      {/* Side decorations — wide screens only, purely ornamental */}
      <div className="pointer-events-none absolute inset-y-0 left-0 z-[5] hidden w-[17rem] flex-col justify-center gap-5 pl-10 min-[1400px]:flex" aria-hidden="true">
        <div className="floaty rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-xl shadow-black/20 backdrop-blur-md" style={{ animationDelay: "-2s" }}>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-300">
              <BadgeCheck size={18} />
            </span>
            <span>
              <span className="block text-xs font-bold text-white">{L("d0t")}</span>
              <span className="block text-[0.7rem] text-emerald-100/60">{L("d0d")}</span>
            </span>
          </div>
          <p className="font-display mt-2.5 text-[1.35rem] font-extrabold tracking-tight text-white">Rs 48,500</p>
        </div>
        <div className="floaty rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-xl shadow-black/20 backdrop-blur-md" style={{ animationDelay: "-5s" }}>
          <div className="flex items-center justify-between">
            <p className="text-xs font-bold text-white">{L("d1t")}</p>
            <TrendingUp size={15} className="text-emerald-300" />
          </div>
          <div className="mt-3 flex h-12 items-end gap-1.5">
            {bars.map((h, i) => (
              <span
                key={i}
                className="w-full rounded-sm bg-gradient-to-t from-emerald-500/40 to-emerald-300/90"
                style={{ height: `${h}%`, opacity: 0.45 + (i / bars.length) * 0.55 }}
              />
            ))}
          </div>
          <p className="mt-2 text-[0.7rem] font-bold text-emerald-300">{L("d1d")}</p>
        </div>
      </div>
      <div className="pointer-events-none absolute inset-y-0 right-0 z-[5] hidden w-[17rem] flex-col justify-center gap-5 pr-10 min-[1400px]:flex" aria-hidden="true">
        <div className="floaty rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-xl shadow-black/20 backdrop-blur-md" style={{ animationDelay: "-3.5s" }}>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-teal-400/15 text-teal-200">
              <HandCoins size={18} />
            </span>
            <span>
              <span className="block text-xs font-bold text-white">{L("d2t")}</span>
              <span className="block text-[0.7rem] text-emerald-100/60">{L("d2d")}</span>
            </span>
          </div>
          <p className="font-display mt-2.5 text-[1.35rem] font-extrabold tracking-tight text-white">Rs 12,000</p>
        </div>
        <div className="floaty rounded-2xl border border-white/10 bg-white/[0.05] p-4 shadow-xl shadow-black/20 backdrop-blur-md" style={{ animationDelay: "-6.5s" }}>
          <div className="flex items-center gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-amber-400/15 text-amber-300">
              <TriangleAlert size={18} />
            </span>
            <span>
              <span className="block text-xs font-bold text-white">{L("d3t")}</span>
              <span className="block text-[0.7rem] text-emerald-100/60">{L("d3d")}</span>
            </span>
          </div>
        </div>
      </div>

      {/* Center stage */}
      <main className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center px-4 pb-14 pt-4 sm:pt-8">
        <div className="rise">
          <BrandMark size={58} className="drop-shadow-[0_10px_30px_rgba(16,185,129,0.5)]" />
        </div>
        <div className="rise rise-1 mt-5 min-h-[3.5rem] text-center sm:min-h-[4rem]">
          <Typewriter
            phrases={phrases}
            caretClassName="text-emerald-300"
            className="font-display bg-gradient-to-r from-emerald-100 via-white to-emerald-100 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-[2rem] sm:leading-snug"
          />
        </div>

        <div className="rise rise-2 mt-6 w-full">{children}</div>

        {/* Feature pills */}
        <ul className="stagger-rise mt-7 grid w-full grid-cols-2 gap-2.5 sm:grid-cols-4">
          {points.map((p) => (
            <li
              key={p.t}
              className="rise flex items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.06] px-3.5 py-3 backdrop-blur-md transition-colors duration-300 hover:bg-white/[0.1]"
              title={L(p.d)}
            >
              <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-400/15 text-emerald-200">
                <p.icon size={17} />
              </span>
              <span className="text-[0.8rem] font-bold leading-tight text-emerald-50">{L(p.t)}</span>
            </li>
          ))}
        </ul>

        <p className="rise rise-4 mt-8 text-center text-xs text-emerald-100/50">{L("footer", { brand: brand.name })}</p>
      </main>
    </div>
  );
}
