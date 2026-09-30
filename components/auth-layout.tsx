"use client";

import Link from "next/link";
import { FileText, Wallet, BarChart3, ShieldCheck } from "lucide-react";
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
          <BrandLockup markSize={34} wordClass="text-[1.02rem] leading-none text-white" tagline dark />
        </Link>
        <div className="flex items-center gap-2">
          <LangToggle />
          <ThemeToggle />
        </div>
      </header>

      {/* Center stage */}
      <main className="relative z-10 mx-auto flex w-full max-w-xl flex-col items-center px-4 pb-14 pt-4 sm:pt-8">
        <div className="rise">
          <BrandMark size={58} className="drop-shadow-[0_10px_30px_rgba(16,185,129,0.5)]" />
        </div>
        <div className="rise rise-1 mt-5 min-h-[3.5rem] text-center sm:min-h-[4rem]">
          <Typewriter
            phrases={phrases}
            caretClassName="text-emerald-300"
            className="bg-gradient-to-r from-emerald-100 via-white to-emerald-100 bg-clip-text text-2xl font-extrabold tracking-tight text-transparent sm:text-[2rem] sm:leading-snug"
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
