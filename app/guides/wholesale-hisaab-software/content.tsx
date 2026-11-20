import Link from "next/link";
import { BookOpen, ShieldCheck, Boxes, Printer, Languages, ArrowRight } from "lucide-react";
import { brand } from "@/lib/brand";

const CHECKS = [
  {
    icon: BookOpen,
    t: "Udhaar control that actually stops over-credit",
    d: "A wholesaler's biggest leak is credit given beyond a party's limit. Look for per-party credit limits that block a credit sale when crossed — with an override that is logged, not silent.",
  },
  {
    icon: ShieldCheck,
    t: "Party ledgers you can trust to the paisa",
    d: "Every invoice, payment, return and discount should land in one party ledger, with ageing that shows who owes what and for how long. If the ledger and the ageing report disagree, the software is guessing.",
  },
  {
    icon: Boxes,
    t: "Stock that follows the goods",
    d: "Wholesale stock moves in bulk, across godowns, with returns and breakage. The app should track quantities and average cost per item, and warn you before you sell stock you do not have.",
  },
  {
    icon: Printer,
    t: "Bills your customers already understand",
    d: "A thermal receipt-style invoice, printed in seconds, with the shop name on top. If your customers need a training session to read the bill, the format is wrong.",
  },
  {
    icon: Languages,
    t: "Urdu and English, side by side",
    d: "Your staff should not need English to run the shop. Menus, bills and reports in Urdu as well as English keep the whole counter on the same page.",
  },
];

const FAQS = [
  {
    q: "Can I move my hisaab from a paper register into the app?",
    a: "Yes — parties, products, opening balances and old invoices can be entered or imported. The rule that matters: every rupee must be accounted for to the paisa, with names exactly as written in the register.",
  },
  {
    q: "Does wholesale hisaab software work without internet?",
    a: "The LedgerPro Android app works fully offline — sales, purchases, stock and payments keep working when the internet is down. Syncing across devices is a paid-plan feature; see the pricing page for which plan includes it.",
  },
  {
    q: "How is this different from a simple khata app?",
    a: "Khata apps track who owes whom. A wholesale hisaab app adds double-entry accounts, stock with average cost, credit limits, ageing, tax withholding and printable bills — the full A-to-Z account of the business, not just the udhaar list.",
  },
];

export default function WholesaleContent() {
  const b = brand.name;
  return (
    <main>
      <section className="relative overflow-hidden bg-[#0a1120] text-white">
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 sm:px-8 sm:py-24">
          <p className="text-xs font-extrabold uppercase tracking-widest text-amber-400">Guides · Wholesale</p>
          <h1 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
            Wholesale hisaab software for Pakistani wholesalers
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            A wholesale business runs on udhaar, stock and trust. This guide explains what a hisaab
            app must do to replace the register — and how {b} handles each part.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/pricing" className="btn !border-0 !bg-white !px-6 !py-3 !text-sm !text-[#101a2c] shadow-lg hover:!bg-slate-100">
              See pricing <ArrowRight size={15} />
            </Link>
            <Link href="/download" className="btn !border !border-white/30 !px-6 !py-3 !text-sm !text-white hover:!bg-white/10">
              Get the app
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">What to check before you choose</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Five things separate a real wholesale accounting app from a notebook with a search box.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {CHECKS.map((c) => (
            <article key={c.t} className="rounded-2xl border border-border bg-card p-5">
              <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
                <c.icon size={20} />
              </span>
              <h3 className="mt-3 font-extrabold">{c.t}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{c.d}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-14 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">How {b} fits a wholesale shop</h2>
        <div className="mt-6 space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p>
            {b} is built for wholesalers first: double-entry accounts with exact paisa math, credit-limit
            enforcement on credit sales, party-wise ageing, stock with moving-average cost and godowns,
            and thermal invoices that look like the paper bills your customers already know.
          </p>
          <p>
            It runs in Urdu and English, works offline on Android, and keeps your data on your own
            device and account — safe for up to 10 years, without depending on a paper register that
            can be lost, torn or misread.
          </p>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 pb-16 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">Common questions</h2>
        <div className="mt-6 space-y-4">
          {FAQS.map((f) => (
            <article key={f.q} className="rounded-2xl border border-border bg-card p-5">
              <h3 className="font-extrabold">{f.q}</h3>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
            </article>
          ))}
        </div>
        <p className="mt-8 text-sm text-muted-foreground">
          Still deciding? Read the <Link href="/guides/hisaab-software-price-pakistan" className="font-bold text-primary hover:underline">price guide</Link> or
          the <Link href="/guides/offline-hisaab-app" className="font-bold text-primary hover:underline">offline guide</Link>.
        </p>
      </section>
    </main>
  );
}
