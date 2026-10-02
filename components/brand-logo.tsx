"use client";

import { brand } from "@/lib/brand";

/**
 * LedgerProSolution brand mark — an original open-ledger motif: two ledger
 * pages, the right page's ruling lines rising into a growth check.
 * Ink & Gold gradient tile (deep navy → primary blue), white linework.
 */
export function BrandMark({ size = 36, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label={brand.name}
    >
      <defs>
        <linearGradient id="lps-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#2b63c4" />
          <stop offset="0.55" stopColor="#1e4fa3" />
          <stop offset="1" stopColor="#101a2c" />
        </linearGradient>
      </defs>
      <rect x="3" y="3" width="58" height="58" rx="16" fill="url(#lps-g)" />
      <rect x="3" y="3" width="58" height="58" rx="16" fill="none" stroke="#0a1428" strokeOpacity="0.35" strokeWidth="1.5" />
      {/* open ledger pages */}
      <path
        d="M32 21c-5.5-3.6-11-4.6-16.5-4.2v25c5.5-.4 11 .6 16.5 4.2"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M32 21c5.5-3.6 11-4.6 16.5-4.2v25c-5.5-.4-11 .6-16.5 4.2"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* ledger ruling lines, left page */}
      <path d="M20.5 27.5h6.5M20.5 33.5h6.5" stroke="#ffffff" strokeWidth="2.6" strokeLinecap="round" opacity="0.9" />
      {/* rising growth check, right page */}
      <path
        d="M37 35.5l3.6 3.6 6.4-8.6"
        fill="none"
        stroke="#ffffff"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Wordmark — "LedgerPro" in the surrounding text color, "Solution" in the
 * primary (sapphire blue) accent on light surfaces, warm gold on dark
 * surfaces (blue-on-navy has no contrast). Same spacing/typography everywhere.
 */
export function BrandWordmark({ className = "", dark = false }: { className?: string; dark?: boolean }) {
  return (
    <span className={`font-extrabold tracking-tight ${className}`}>
      LedgerPro<span className={dark ? "text-[#f0b73f]" : "text-primary"}>Solution</span>
    </span>
  );
}

/**
 * Full lockup: mark + wordmark (+ optional tagline). Used in the app header,
 * auth screens and the landing nav so the brand reads identically everywhere.
 */
export function BrandLockup({
  markSize = 36,
  wordClass = "text-[1.05rem] leading-none",
  tagline = false,
  dark = false,
}: {
  markSize?: number;
  wordClass?: string;
  tagline?: boolean;
  dark?: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <BrandMark size={markSize} className="shrink-0 drop-shadow-sm" />
      <span className="min-w-0">
        <BrandWordmark dark={dark} className={`block ${wordClass} ${dark ? "text-white" : ""}`} />
        {tagline && (
          <span className={`mt-0.5 block text-[0.68rem] font-medium ${dark ? "text-white/70" : "text-muted-foreground"}`}>
            {brand.tagline}
          </span>
        )}
      </span>
    </span>
  );
}
