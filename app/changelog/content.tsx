"use client";

import Link from "next/link";
import { CHANGELOG } from "@/lib/changelog";
import { useLang } from "@/components/lang-provider";
import PubHeader from "../pub-header";

export default function ChangelogContent() {
  const { t } = useLang();
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("changelog.title")}</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">{t("changelog.intro")}</p>

        <ol className="mt-10 space-y-8">
          {CHANGELOG.map((e) => (
            <li key={e.tag} className="relative pl-6">
              <span className="absolute left-0 top-1.5 h-2.5 w-2.5 rounded-full bg-primary ring-4 ring-primary/15" />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h2 className="text-lg font-extrabold">{e.title}</h2>
              </div>
              <p className="mt-1 text-xs font-semibold text-muted-foreground">
                {e.date} <span className="mx-1.5">·</span>
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{e.tag}</code>
              </p>
              <ul className="mt-3 space-y-1.5">
                {e.bullets.map((b, i) => (
                  <li key={i} className="flex gap-2.5 text-sm leading-relaxed text-muted-foreground">
                    <span className="mt-[0.55rem] h-1.5 w-1.5 shrink-0 rounded-full bg-primary/50" />
                    <span>{b}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>

        <p className="mt-12 border-t border-border pt-6 text-center text-sm">
          <Link href="/support" className="font-bold text-primary hover:underline">{t("changelog.supportLink")}</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">{t("pub.backHome")}</Link>
        </p>
      </main>
    </div>
  );
}
