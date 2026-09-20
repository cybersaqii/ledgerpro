"use client";

import Link from "next/link";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

export default function PrivacyContent() {
  const { t } = useLang();
  const b = brand.name;
  const sections: { h: string; p: string[] }[] = [
    { h: t("privacy.s0h"), p: [t("privacy.s0p0"), t("privacy.s0p1"), t("privacy.s0p2")] },
    { h: t("privacy.s1h"), p: [t("privacy.s1p0"), t("privacy.s1p1"), t("privacy.s1p2")] },
    { h: t("privacy.s2h"), p: [t("privacy.s2p0")] },
    { h: t("privacy.s3h"), p: [t("privacy.s3p0")] },
    { h: t("privacy.s4h"), p: [t("privacy.s4p0"), t("privacy.s4p1"), t("privacy.s4p2")] },
    { h: t("privacy.s5h"), p: [t("privacy.s5p0")] },
    { h: t("privacy.s6h"), p: [t("privacy.s6p0")] },
    { h: t("privacy.s7h"), p: [t("privacy.s7p0", { brand: b })] },
  ];
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
      <h1 className="text-3xl font-extrabold tracking-tight">{t("privacy.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("privacy.updated")}</p>
      <div className="mt-8 space-y-8">
        {sections.map((s) => (
          <section key={s.h}>
            <h2 className="text-lg font-extrabold">{s.h}</h2>
            {s.p.map((t2, i) => (
              <p key={i} className="mt-2 leading-relaxed text-muted-foreground">{t2}</p>
            ))}
          </section>
        ))}
      </div>
      <p className="mt-12 border-t border-border pt-6 text-center text-sm">
        <Link href="/terms" className="font-bold text-primary hover:underline">{t("privacy.termsLink")}</Link>
        <span className="mx-3 text-muted-foreground">·</span>
        <Link href="/" className="font-bold text-primary hover:underline">{t("pub.backHome")}</Link>
      </p>
    </main>
  );
}
