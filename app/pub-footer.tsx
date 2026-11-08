"use client";

import Link from "next/link";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

/**
 * Shared footer for public pages.
 *
 * Sunday sweep 2026-11-08 (HIGH 3): every public page except the landing
 * ended abruptly — no footer, no Start-free CTA, no Terms/Privacy/Changelog
 * links, no contact details. The landing footer carries the same links;
 * this is its compact form for /pricing, /support, /download, /changelog,
 * /terms, /privacy and /about.
 */
export default function PubFooter() {
  const { t } = useLang();
  return (
    <footer className="bg-[#0a1120] text-white">
      <div className="mx-auto flex max-w-4xl flex-col gap-4 px-4 py-8 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <p className="text-base font-extrabold tracking-tight">{brand.name}</p>
          <Link
            href="/signup"
            className="rounded-full bg-white px-5 py-2 text-sm font-extrabold text-[#101a2c] transition hover:bg-slate-100"
          >
            {t("landing.footStart")}
          </Link>
        </div>
        <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <Link href="/pricing" className="text-white/75 transition hover:text-white">{t("landing.navPricing")}</Link>
          <Link href="/download" className="text-white/75 transition hover:text-white">{t("landing.footAndroid")}</Link>
          <Link href="/about" className="text-white/75 transition hover:text-white">{t("about.title")}</Link>
          <Link href="/support" className="text-white/75 transition hover:text-white">{t("landing.footSupport")}</Link>
          <Link href="/changelog" className="text-white/75 transition hover:text-white">{t("landing.footChangelog")}</Link>
          <Link href="/terms" className="text-white/75 transition hover:text-white">{t("landing.footTerms")}</Link>
          <Link href="/privacy" className="text-white/75 transition hover:text-white">{t("landing.footPrivacy")}</Link>
        </nav>
        <p className="text-sm text-white/70">
          <a href={`mailto:${brand.supportEmail}`} dir="ltr" className="font-semibold text-white/85 transition hover:text-white">{brand.supportEmail}</a>
          <span className="mx-2 text-white/40">·</span>
          <a href={`tel:${brand.supportPhone}`} dir="ltr" className="font-semibold text-white/85 transition hover:text-white">0323 8737464</a>
        </p>
        <p className="border-t border-white/10 pt-4 text-xs text-white/60">
          © 2026 {brand.name}. {t("landing.footRights")}
        </p>
      </div>
    </footer>
  );
}
