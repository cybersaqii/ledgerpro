import Link from "next/link";
import { FileText } from "lucide-react";
import { brand } from "@/lib/brand";

const sections: { h: string; p: string[] }[] = [
  {
    h: "1. What LedgerPro is",
    p: [
      `${brand.name} is an online accounting workspace for small and medium businesses: sales and purchase bills, stock, payments, expenses and reports, built on double-entry accounting. Creating a company and getting started is free; you never need a credit card to try it.`,
    ],
  },
  {
    h: "2. Your account",
    p: [
      "You are responsible for keeping your login secret and for everything done under your account. One account may be used by your own staff; give each person their own login where the app supports roles.",
      "You must provide accurate business details at signup and keep them up to date.",
    ],
  },
  {
    h: "3. Your data is yours",
    p: [
      "Every party, product, bill, payment and report you create belongs to you. You can export your full data as JSON or CSV at any time from Settings.",
      "Posted accounting documents are permanent by design — that is what keeps the books trustworthy. To correct a posted bill, create a return document rather than editing history.",
    ],
  },
  {
    h: "4. Fair use",
    p: [
      "Do not misuse the service: no attempts to break in, overload the system, scrape other users' data, or use the service for anything unlawful. We may suspend accounts that abuse the service or put other users' data at risk.",
    ],
  },
  {
    h: "5. No tax or legal advice",
    p: [
      `${brand.name} records your transactions accurately but is not a tax consultant, auditor or lawyer. Tax treatment, filing and compliance remain your responsibility — confirm with a qualified professional where it matters.`,
    ],
  },
  {
    h: "6. Availability and liability",
    p: [
      "We work to keep the service reliable and your data safe, and every entry is stored with balanced double-entry checks. Even so, the service is provided \"as is\". To the maximum extent allowed by law, our liability is limited to the amounts you paid us in the 12 months before the claim (which is zero on the free tier).",
    ],
  },
  {
    h: "7. Changes and termination",
    p: [
      "You may stop using the service at any time — export your data first from Settings. We may update these terms; material changes will be announced in the app. Continued use after changes take effect means you accept them.",
    ],
  },
  {
    h: "8. Contact",
    p: [
      `Questions about these terms? Reach us through the contact details published on ${brand.name}'s website.`,
    ],
  },
];

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-[#0a2e25]">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15">
              <FileText size={18} className="text-white" />
            </span>
            <span className="text-[1.05rem] font-extrabold tracking-tight text-white">{brand.name}</span>
          </Link>
          <Link href="/login" className="text-sm font-bold text-emerald-100/80 transition hover:text-white">Log in</Link>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">Terms of Service</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: September 2026</p>
        <div className="mt-8 space-y-8">
          {sections.map((s) => (
            <section key={s.h}>
              <h2 className="text-lg font-extrabold">{s.h}</h2>
              {s.p.map((t, i) => (
                <p key={i} className="mt-2 leading-relaxed text-muted-foreground">{t}</p>
              ))}
            </section>
          ))}
        </div>
        <p className="mt-12 border-t border-border pt-6 text-center text-sm">
          <Link href="/privacy" className="font-bold text-primary hover:underline">Privacy Policy</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">Back to home</Link>
        </p>
      </main>
    </div>
  );
}
