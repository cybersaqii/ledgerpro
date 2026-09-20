import type { Metadata } from "next";
import Link from "next/link";
import { History } from "lucide-react";
import { brand } from "@/lib/brand";
import { CHANGELOG } from "@/lib/changelog";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What shipped recently in ${brand.name} — new features and improvements.`,
};

export default function ChangelogPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-[#0a2e25]">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15">
              <History size={18} className="text-white" />
            </span>
            <span className="text-[1.05rem] font-extrabold tracking-tight text-white">{brand.name}</span>
          </Link>
          <Link href="/login" className="text-sm font-bold text-emerald-100/80 transition hover:text-white">Log in</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">Changelog</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Everything we ship, newest first. Each entry links to the exact change in our history.
        </p>

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
          <Link href="/support" className="font-bold text-primary hover:underline">Support</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">Back to home</Link>
        </p>
      </main>
    </div>
  );
}
