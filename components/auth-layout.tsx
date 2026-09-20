"use client";

import Link from "next/link";
import { FileText, Wallet, BarChart3, ShieldCheck } from "lucide-react";
import { Logo, ThemeToggle, LangToggle } from "./ui";
import { brand } from "@/lib/brand";
import { useLang } from "./lang-provider";
import type { ReactNode } from "react";

const points = [
  { icon: FileText, t: "p0t", d: "p0d" },
  { icon: Wallet, t: "p1t", d: "p1d" },
  { icon: BarChart3, t: "p2t", d: "p2d" },
  { icon: ShieldCheck, t: "p3t", d: "p3d" },
];

export function AuthLayout({ children }: { children: ReactNode }) {
  const { t } = useLang();
  const L = (k: string, vars?: Record<string, string | number>) => t(`authlayout.${k}`, vars);
  return (
    <div className="flex min-h-screen bg-background">
      {/* Brand panel */}
      <aside className="relative hidden w-[42%] shrink-0 overflow-hidden md:block lg:w-[44%]">
        <div className="auth-pan absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0d7a5f]" />
        <div className="pointer-events-none absolute inset-0">
          <div className="orb-drift absolute -top-24 -left-24 h-96 w-96 rounded-full bg-emerald-400/20 blur-[100px]" />
          <div className="orb-drift-rev absolute bottom-0 right-0 h-[28rem] w-[28rem] rounded-full bg-teal-300/10 blur-[120px]" />
          <div className="absolute inset-0 opacity-[0.07]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        </div>
        <div className="relative flex h-full flex-col justify-between p-6 text-white lg:p-10">
          <Link href="/" className="rise inline-flex items-center gap-3">
            <span className="grid h-11 w-11 place-items-center rounded-2xl bg-white/15 shadow-lg backdrop-blur">
              <FileText size={22} className="text-white" />
            </span>
            <span>
              <span className="block text-lg font-extrabold tracking-tight">{brand.name}</span>
              <span className="block text-xs text-emerald-100/80">{brand.tagline}</span>
            </span>
          </Link>
          <div>
            <h2 className="rise rise-1 max-w-md text-2xl font-extrabold leading-tight tracking-tight xl:text-4xl">
              {L("headline")}
            </h2>
            <ul className="stagger-rise mt-8 space-y-5">
              {points.map((p) => (
                <li key={p.t} className="rise flex items-start gap-4">
                  <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-white/12 backdrop-blur transition-transform duration-300 hover:scale-110">
                    <p.icon size={20} className="text-emerald-100" />
                  </span>
                  <span>
                    <span className="block font-bold">{L(p.t)}</span>
                    <span className="block text-sm text-emerald-100/75">{L(p.d)}</span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <p className="rise rise-4 text-xs text-emerald-100/60">{L("footer", { brand: brand.name })}</p>
        </div>
      </aside>

      {/* Form side */}
      <div className="flex min-h-screen flex-1 flex-col">
        <header className="flex h-16 items-center justify-between px-4 sm:px-8">
          <Link href="/" className="md:hidden"><Logo /></Link>
          <span className="hidden md:block" />
          <div className="flex items-center gap-2">
            <LangToggle />
            <ThemeToggle />
          </div>
        </header>
        <main className="relative flex flex-1 items-center justify-center px-4 pb-16">
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-72 bg-gradient-to-b from-primary/[0.08] to-transparent" />
            <div className="orb-drift absolute -top-24 right-0 h-72 w-72 rounded-full bg-primary/15 blur-[90px]" />
            <div className="orb-drift-rev absolute bottom-0 left-1/4 h-72 w-72 rounded-full bg-accent/15 blur-[90px]" />
            <div className="absolute inset-0 opacity-60" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, var(--border) 1.2px, transparent 0)", backgroundSize: "26px 26px", maskImage: "linear-gradient(to bottom, black 0%, transparent 65%)", WebkitMaskImage: "linear-gradient(to bottom, black 0%, transparent 65%)" }} />
          </div>
          <div className="relative w-full max-w-md">{children}</div>
        </main>
      </div>
    </div>
  );
}
