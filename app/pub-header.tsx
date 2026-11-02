"use client";

import Link from "next/link";
import { FileText } from "lucide-react";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import { LangToggle } from "@/components/ui";

/** Shared header for public pages (terms, privacy, support, changelog). */
export default function PubHeader() {
  const { t } = useLang();
  return (
    <header className="border-b border-white/10 bg-[#0a1120]">
      <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-8">
        <Link href="/" className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15">
            <FileText size={18} className="text-white" />
          </span>
          <span className="text-[1.05rem] font-extrabold tracking-tight text-white">{brand.name}</span>
        </Link>
        {/* QA sweep 2026-11-01: support/legal pages had no Support link and
            no Urdu toggle — both live here now. */}
        <div className="flex items-center gap-4">
          <Link href="/support" className="text-sm font-bold text-white/75 transition hover:text-white">{t("landing.footSupport")}</Link>
          <LangToggle />
          <Link href="/login" className="text-sm font-bold text-white/75 transition hover:text-white">{t("pub.login")}</Link>
        </div>
      </div>
    </header>
  );
}
