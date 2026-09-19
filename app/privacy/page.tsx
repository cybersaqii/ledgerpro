import Link from "next/link";
import { FileText } from "lucide-react";
import { brand } from "@/lib/brand";

const sections: { h: string; p: string[] }[] = [
  {
    h: "1. What we collect",
    p: [
      `Account data: your name, email, password (stored as a one-way hash — we never see it), and the business profile you enter at signup (business name, type, address, city, phone).`,
      `Business data: everything you record in the app — parties, products, bills, payments, expenses, stock and reports. This is your data; we only store and process it to run the service for you.`,
      `Technical data: basic logs needed for security and reliability (such as login attempts and error reports). We do not use advertising trackers.`,
    ],
  },
  {
    h: "2. How we use it",
    p: [
      "To operate your workspace: sign you in, save your entries, compute your reports and keep your history safe.",
      "To protect the service: detect abuse, prevent fraud and fix bugs.",
      "We do not sell your data, and we do not share it with advertisers.",
    ],
  },
  {
    h: "3. Where it is stored",
    p: [
      "Your data is stored in a managed cloud database with encrypted connections and regular backups. Access is limited to what is needed to operate the service.",
    ],
  },
  {
    h: "4. Cookies",
    p: [
      "We use a single session cookie to keep you logged in, plus a theme preference. No third-party advertising cookies.",
    ],
  },
  {
    h: "5. Your rights",
    p: [
      "Export: download your full data as JSON or export any register as CSV from Settings, anytime.",
      "Correction: update your profile and business details in Settings.",
      "Deletion: you may stop using the service at any time. Contact us and we will delete your account and business data, except where we must keep limited records for legal reasons.",
    ],
  },
  {
    h: "6. Data retention",
    p: [
      "While your account is active, your complete history is kept safe (up to 10 years of records). If you delete your account, your business data is removed as described above.",
    ],
  },
  {
    h: "7. Changes",
    p: [
      "We may update this policy as the product evolves; material changes will be announced in the app. Continued use after changes take effect means you accept the updated policy.",
    ],
  },
  {
    h: "8. Contact",
    p: [
      `Questions about your data? Reach us through the contact details published on ${brand.name}'s website.`,
    ],
  },
];

export default function PrivacyPage() {
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
        <h1 className="text-3xl font-extrabold tracking-tight">Privacy Policy</h1>
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
          <Link href="/terms" className="font-bold text-primary hover:underline">Terms of Service</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">Back to home</Link>
        </p>
      </main>
    </div>
  );
}
