"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LangToggle } from "./ui";
import { BrandLockup, BrandMark } from "./brand-logo";
import { Typewriter, type TwPhrase } from "./typewriter";
import { brand } from "@/lib/brand";
import { useLang } from "./lang-provider";
import { en } from "@/lib/i18n/en";
import { ur } from "@/lib/i18n/ur";
import type { ReactNode } from "react";

const DONUT_C = 2 * Math.PI * 30;

const legend = [
  { color: "#10b981", key: "c1l0" },
  { color: "#f59e0b", key: "c1l1" },
  { color: "#cbd5e1", key: "c1l2" },
];

const allocations = [
  { color: "#10b981", key: "c3i0", value: "Rs 5,20,000" },
  { color: "#38bdf8", key: "c3i1", value: "Rs 3,10,000" },
  { color: "#f59e0b", key: "c3i2", value: "Rs 1,45,000" },
];

/**
 * Split-card auth shell: a light floating card with the form on the left and a
 * deep-emerald showcase panel on the right (floating mini dashboard cards,
 * typewriter headline). Original LedgerPro content and emerald brand only.
 */
export function AuthLayout({
  children,
  heading,
  sub,
  tabs,
}: {
  children: ReactNode;
  heading?: ReactNode;
  sub?: ReactNode;
  /** Force the Sign In / Sign Up tab switcher on or off (default: on for /login and /signup). */
  tabs?: boolean;
}) {
  const { t } = useLang();
  const pathname = usePathname();
  const L = (k: string, vars?: Record<string, string | number>) => t(`authlayout.${k}`, vars);
  const showTabs = tabs ?? (pathname === "/login" || pathname === "/signup");
  const phrases: TwPhrase[] = [
    { text: en.authlayout.tp0 },
    { text: ur.authlayout?.tp0 ?? en.authlayout.tp0, rtl: true },
    { text: en.authlayout.tp1 },
    { text: ur.authlayout?.tp1 ?? en.authlayout.tp1, rtl: true },
  ];

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[#e9f1ee] px-3 py-8 sm:px-6 sm:py-12">
      {/* Page backdrop */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div className="absolute -top-24 start-[8%] h-96 w-96 rounded-full bg-emerald-200/50 blur-[120px]" />
        <div className="absolute end-[4%] bottom-0 h-80 w-80 rounded-full bg-teal-200/50 blur-[110px]" />
        <div
          className="absolute inset-0 opacity-[0.35]"
          style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #0f766e 1px, transparent 0)", backgroundSize: "34px 34px", opacity: 0.05 }}
        />
      </div>
      <div className="absolute top-4 end-4 z-20 sm:top-6 sm:end-6">
        <LangToggle />
      </div>

      {/* Card */}
      <div className="relative z-10 grid min-h-[80vh] w-full max-w-6xl overflow-hidden rounded-[1.75rem] bg-white shadow-2xl shadow-emerald-950/15 md:grid-cols-[1fr_1.05fr]">
        {/* Left — form side */}
        <div className="flex flex-col p-6 sm:p-10 lg:px-12">
          <Link href="/" aria-label={brand.name} className="self-start">
            <BrandLockup markSize={34} wordClass="font-display text-[1.05rem] leading-none" tagline />
          </Link>

          <div className="flex flex-1 flex-col justify-center py-6">
          {heading ? (
            <h1 className="font-display mt-8 text-[1.65rem] font-extrabold tracking-tight text-slate-900">{heading}</h1>
          ) : null}
          {sub ? <p className="mt-2 text-sm leading-relaxed text-slate-500">{sub}</p> : null}

          {showTabs && (
            <div className="mt-6 grid grid-cols-2 rounded-xl bg-slate-100 p-1 text-sm font-bold" role="tablist" aria-label={L("tabIn")}>
              <Link
                href="/login"
                role="tab"
                aria-selected={pathname === "/login"}
                className={`rounded-lg py-2.5 text-center transition ${
                  pathname === "/login"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {L("tabIn")}
              </Link>
              <Link
                href="/signup"
                role="tab"
                aria-selected={pathname === "/signup"}
                className={`rounded-lg py-2.5 text-center transition ${
                  pathname === "/signup"
                    ? "bg-white text-slate-900 shadow-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {L("tabUp")}
              </Link>
            </div>
          )}

          <div className="mt-6">{children}</div>
          </div>

          <p className="text-center text-xs text-slate-400">{L("footer", { brand: brand.name })}</p>
        </div>

        {/* Right — showcase side */}
        <div className="relative hidden flex-col overflow-hidden bg-[#0a2e25] p-8 md:flex lg:p-10">
          <div className="absolute inset-0 bg-gradient-to-br from-[#0d4434] via-[#0a2e25] to-[#071f19]" aria-hidden="true" />
          <div className="pointer-events-none absolute inset-0" aria-hidden="true">
            <div className="absolute -top-20 end-0 h-72 w-72 rounded-full bg-emerald-400/15 blur-[100px]" />
            <div className="absolute bottom-10 -start-16 h-64 w-64 rounded-full bg-teal-300/10 blur-[90px]" />
            <div
              className="absolute inset-0 opacity-[0.06]"
              style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }}
            />
          </div>

          {/* Floating dashboard cards */}
          <div className="relative mb-4 h-64 shrink-0" aria-hidden="true">
            <div className="floaty absolute top-0 start-0 w-44 rounded-2xl bg-white p-4 shadow-xl shadow-black/25" style={{ animationDelay: "-1.2s" }}>
              <p className="text-[0.65rem] font-bold tracking-wider text-slate-400 uppercase">{L("c1t")}</p>
              <div className="mt-2 flex justify-center">
                <svg viewBox="0 0 76 76" className="h-[4.4rem] w-[4.4rem] -rotate-90" role="img">
                  <circle cx="38" cy="38" r="30" fill="none" stroke="#edf2f4" strokeWidth="11" />
                  <circle cx="38" cy="38" r="30" fill="none" stroke="#10b981" strokeWidth="11" strokeLinecap="round" strokeDasharray={`${DONUT_C * 0.55} ${DONUT_C}`} />
                  <circle cx="38" cy="38" r="30" fill="none" stroke="#f59e0b" strokeWidth="11" strokeDasharray={`${DONUT_C * 0.3} ${DONUT_C}`} strokeDashoffset={-(DONUT_C * 0.55)} />
                  <circle cx="38" cy="38" r="30" fill="none" stroke="#cbd5e1" strokeWidth="11" strokeDasharray={`${DONUT_C * 0.15} ${DONUT_C}`} strokeDashoffset={-(DONUT_C * 0.85)} />
                </svg>
              </div>
              <p className="font-display mt-1 text-center text-[1.05rem] font-extrabold text-slate-900">Rs 84,500</p>
              <ul className="mt-2 space-y-1">
                {legend.map((l) => (
                  <li key={l.key} className="flex items-center gap-1.5 text-[0.68rem] font-semibold text-slate-500">
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: l.color }} />
                    {L(l.key)}
                  </li>
                ))}
              </ul>
            </div>
            <div className="floaty absolute top-8 end-0 w-52 rounded-2xl bg-white p-4 shadow-xl shadow-black/25" style={{ animationDelay: "-3.4s" }}>
              <p className="text-[0.65rem] font-bold tracking-wider text-slate-400 uppercase">{L("c2t")}</p>
              <p className="mt-1.5 text-sm font-extrabold text-slate-900">{L("c2d")}</p>
              <div className="mt-2.5 h-2 overflow-hidden rounded-full bg-slate-100">
                <div className="h-full w-[72%] rounded-full bg-gradient-to-r from-emerald-500 to-teal-400" />
              </div>
              <p className="mt-1.5 text-[0.7rem] font-semibold text-slate-500">{L("c2p")}</p>
            </div>
            <div className="floaty absolute bottom-0 start-12 w-60 rounded-2xl bg-white p-4 shadow-xl shadow-black/25" style={{ animationDelay: "-5.6s" }}>
              <p className="text-[0.65rem] font-bold tracking-wider text-slate-400 uppercase">{L("c3t")}</p>
              <ul className="mt-2 space-y-2">
                {allocations.map((a) => (
                  <li key={a.key} className="flex items-center justify-between text-[0.72rem]">
                    <span className="flex items-center gap-1.5 font-semibold text-slate-500">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: a.color }} />
                      {L(a.key)}
                    </span>
                    <span className="font-extrabold text-slate-900">{a.value}</span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Brand + headline */}
          <div className="relative flex flex-1 flex-col items-center justify-center px-2 text-center">
            <BrandMark size={52} className="drop-shadow-[0_10px_30px_rgba(16,185,129,0.45)]" />
            <div className="mt-5 min-h-[3.2rem]">
              <Typewriter
                phrases={phrases}
                caretClassName="text-emerald-300"
                className="font-display bg-gradient-to-r from-emerald-100 via-white to-emerald-100 bg-clip-text text-[1.45rem] leading-snug font-extrabold tracking-tight text-transparent"
              />
            </div>
            <p className="mt-3 max-w-sm text-[0.83rem] leading-relaxed text-emerald-100/70">{L("scSub")}</p>
          </div>

          {/* Carousel dots (decorative) */}
          <div className="relative mt-6 flex items-center justify-center gap-2" aria-hidden="true">
            <span className="h-1.5 w-10 rounded-full bg-white/80" />
            <span className="h-1.5 w-10 rounded-full bg-white/25" />
            <span className="h-1.5 w-10 rounded-full bg-white/25" />
            <span className="h-1.5 w-10 rounded-full bg-white/25" />
          </div>
        </div>
      </div>
    </div>
  );
}
