"use client";

import Link from "next/link";
import { MessageCircle, Smartphone, WifiOff, Download } from "lucide-react";
import { whatsappLink } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import PubHeader from "../pub-header";
import PubFooter from "../pub-footer";

/**
 * Android app page (QA sweep 2026-11-01: the landing claimed a mobile
 * app with offline sync but offered no download path). The APK is
 * direct-install, not on the Play Store, and it is sent on WhatsApp —
 * Sunday sweep 2026-11-08: the old "Direct install" card promised an
 * on-page install that does not exist, so the card now says plainly
 * that the APK arrives on WhatsApp.
 */
export default function DownloadContent() {
  const { t, lang } = useLang();
  const L = (k: string) => t(`download.${k}`);
  return (
    <div dir={lang === "ur" ? "rtl" : "ltr"} className="min-h-screen bg-background">
      <PubHeader />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <span className="grid h-14 w-14 place-items-center rounded-2xl bg-primary-soft text-primary">
          <Smartphone size={26} />
        </span>
        <h1 className="mt-5 text-3xl font-extrabold tracking-tight">{L("title")}</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">{L("intro")}</p>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <div className="card p-6">
            <WifiOff size={20} className="text-primary" />
            <h2 className="mt-3 font-extrabold">{L("offlineTitle")}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{L("offlineDesc")}</p>
          </div>
          <div className="card p-6">
            <Download size={20} className="text-primary" />
            <h2 className="mt-3 font-extrabold">{L("installTitle")}</h2>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{L("installDesc")}</p>
          </div>
        </div>

        <div className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center">
          <a
            href={whatsappLink(L("waText")) ?? "/support"}
            target="_blank"
            rel="noopener"
            className="btn btn-primary !px-7 !py-3.5 text-sm"
          >
            <MessageCircle size={17} /> {L("ctaWhatsapp")}
          </a>
          <Link href="/support" className="btn btn-ghost !px-7 !py-3.5 text-sm">
            {L("ctaSupport")}
          </Link>
        </div>
        <p className="mt-6 text-sm text-muted-foreground">{L("note")}</p>

        <p className="mt-12 border-t border-border pt-6 text-center text-sm">
          <Link href="/" className="font-bold text-primary hover:underline">{t("pub.backHome")}</Link>
        </p>
      </main>
      <PubFooter />
    </div>
  );
}
