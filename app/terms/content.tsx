"use client";

import Link from "next/link";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

export default function TermsContent() {
  const { t } = useLang();
  const b = brand.name;
  const sections: { h: string; p: string[] }[] = [
    { h: t("terms.s0h", { brand: b }), p: [t("terms.s0p0", { brand: b })] },
    { h: t("terms.s1h"), p: [t("terms.s1p0"), t("terms.s1p1")] },
    { h: t("terms.s2h"), p: [t("terms.s2p0"), t("terms.s2p1")] },
    { h: t("terms.s3h"), p: [t("terms.s3p0")] },
    { h: t("terms.s4h"), p: [t("terms.s4p0", { brand: b })] },
    { h: t("terms.s5h"), p: [t("terms.s5p0")] },
    { h: t("terms.s6h"), p: [t("terms.s6p0")] },
    { h: t("terms.s7h"), p: [t("terms.s7p0", { brand: b })] },
  ];
  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
      <h1 className="text-3xl font-extrabold tracking-tight">{t("terms.title")}</h1>
      <p className="mt-2 text-sm text-muted-foreground">{t("terms.updated")}</p>
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
        <Link href="/privacy" className="font-bold text-primary hover:underline">{t("terms.privacyLink")}</Link>
        <span className="mx-3 text-muted-foreground">·</span>
        <Link href="/" className="font-bold text-primary hover:underline">{t("pub.backHome")}</Link>
      </p>
    </main>
  );
}
