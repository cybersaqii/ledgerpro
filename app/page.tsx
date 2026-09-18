import Link from "next/link";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, TrendingUp, Users, Wallet,
} from "lucide-react";
import { Logo, ThemeToggle } from "@/components/ui";
import { brand } from "@/lib/brand";

const features = [
  { icon: FileText, title: "Sales & purchase bills", text: "Invoices, returns, quotations and orders with automatic double-entry posting behind every document." },
  { icon: Boxes, title: "Smart stock control", text: "Quantities, average-cost valuation and low-stock alerts across all your branches." },
  { icon: Wallet, title: "Payments & receipts", text: "Allocate every receipt against invoices. Know exactly who owes you — and who you owe — at any second." },
  { icon: BarChart3, title: "Reports that matter", text: "Profit & loss, balance sheet, trial balance, party ledgers and stock valuation in one click." },
  { icon: ScanBarcode, title: "Fast billing", text: "Search products by name or SKU and build a bill in seconds — even on a phone." },
  { icon: ShieldCheck, title: "Safe for 10 years", text: "Every entry is balanced and permanent. Your complete business history, always verifiable." },
  { icon: Users, title: "Parties & credit limits", text: "Customers and suppliers with balances, credit limits and full transaction history." },
  { icon: Landmark, title: "Cash & bank", text: "Track every cash drawer, bank account and wallet with automatic balance updates." },
  { icon: Smartphone, title: "Works everywhere", text: "Fast on mobile, tablet and desktop. Light and dark mode included." },
];

const steps = [
  { n: "1", title: "Add your stock & parties", text: "Enter your products and customers in minutes." },
  { n: "2", title: "Bill like always", text: "Create sale and purchase bills the way you already do." },
  { n: "3", title: "Watch it all add up", text: "Stock, cash, profit and dues update themselves." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip">
      {/* Nav */}
      <header className="sticky top-0 z-40 border-b border-border/70 bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-4 sm:px-6">
          <Link href="/"><Logo /></Link>
          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            <Link href="/login" className="btn btn-ghost hidden !px-4 !py-2 text-sm sm:inline-flex">Log in</Link>
            <Link href="/signup" className="btn btn-primary !px-4 !py-2 text-sm">
              Start free <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative">
        <div className="pointer-events-none absolute inset-0 -z-10">
          <div className="absolute -top-32 left-1/2 h-[480px] w-[820px] -translate-x-1/2 rounded-full bg-primary/15 blur-[120px]" />
          <div className="absolute top-40 -left-40 h-96 w-96 rounded-full bg-accent/10 blur-[100px]" />
        </div>
        <div className="mx-auto max-w-7xl px-4 pb-16 pt-16 text-center sm:px-6 sm:pt-24">
          <div className="rise mx-auto inline-flex items-center gap-2 rounded-full border border-border bg-card px-4 py-1.5 text-xs font-semibold text-muted-foreground shadow-sm">
            <Sparkles size={14} className="text-accent" />
            Built for wholesale traders
          </div>
          <h1 className="rise rise-1 mx-auto mt-6 max-w-3xl text-4xl font-extrabold leading-[1.08] tracking-tight sm:text-6xl">
            Your entire wholesale{" "}
            <span className="bg-gradient-to-r from-primary to-emerald-500 bg-clip-text text-transparent">hisaab</span>,
            finally in one place
          </h1>
          <p className="rise rise-2 mx-auto mt-5 max-w-2xl text-base text-muted-foreground sm:text-lg">
            {brand.description} No more registers, no more guesswork — just clear numbers you can trust.
          </p>
          <div className="rise rise-3 mt-8 flex flex-wrap items-center justify-center gap-3">
            <Link href="/signup" className="btn btn-primary !px-7 !py-3.5 !text-base">
              Start free today <ArrowRight size={18} />
            </Link>
            <Link href="/login" className="btn btn-ghost !px-7 !py-3.5 !text-base">Log in</Link>
          </div>

          {/* Floating dashboard mock */}
          <div className="rise rise-4 relative mx-auto mt-14 max-w-4xl">
            <div className="floaty card card-gloss p-5 text-left sm:p-7">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Today&apos;s business</p>
                  <p className="mt-1 text-3xl font-extrabold tracking-tight">Rs 1,84,500</p>
                </div>
                <span className="badge bg-primary-soft text-primary"><TrendingUp size={13} /> +18% this week</span>
              </div>
              <div className="mt-6 grid grid-cols-3 gap-3">
                {[
                  { l: "To receive", v: "Rs 96,200" },
                  { l: "To pay", v: "Rs 41,750" },
                  { l: "Stock value", v: "Rs 5,20,000" },
                ].map((s) => (
                  <div key={s.l} className="rounded-xl bg-muted/70 p-3 sm:p-4">
                    <p className="text-[0.68rem] font-semibold uppercase tracking-wider text-muted-foreground">{s.l}</p>
                    <p className="mt-1 text-sm font-extrabold sm:text-lg">{s.v}</p>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex items-end gap-1.5" aria-hidden>
                {[35, 55, 40, 70, 52, 88, 64, 95, 74, 100, 82, 92].map((h, i) => (
                  <div key={i} className="flex-1 rounded-t-md bg-gradient-to-t from-primary/70 to-primary/25" style={{ height: `${h * 0.9}px` }} />
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20">
        <div className="text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Everything a wholesaler needs</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">From the first purchase bill to the final profit report — {brand.name} handles the full cycle.</p>
        </div>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map((f, i) => (
            <div key={f.title} className={`card card-gloss rise p-6 rise-${(i % 4) + 1}`}>
              <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary-soft text-primary">
                <f.icon size={22} />
              </span>
              <h3 className="mt-4 text-base font-bold">{f.title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Steps */}
      <section className="border-y border-border bg-card/60">
        <div className="mx-auto max-w-7xl px-4 py-16 sm:px-6 sm:py-20">
          <h2 className="text-center text-3xl font-extrabold tracking-tight">Up and running in three steps</h2>
          <div className="mt-10 grid gap-4 md:grid-cols-3">
            {steps.map((s) => (
              <div key={s.n} className="card p-6">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-primary text-lg font-extrabold text-primary-foreground">{s.n}</span>
                <h3 className="mt-4 text-base font-bold">{s.title}</h3>
                <p className="mt-1 text-sm text-muted-foreground">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="mx-auto max-w-7xl px-4 py-14 sm:px-6">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { t: "Double-entry core", d: "Every rupee is debited and credited. Books always balance." },
            { t: "Beginner friendly", d: "Simple words, guided forms — no accounting degree needed." },
            { t: "Your data stays yours", d: "Secure company login. Your business stays private." },
          ].map((x) => (
            <div key={x.t} className="flex items-start gap-3 rounded-2xl border border-border bg-card p-5">
              <CheckCircle2 size={20} className="mt-0.5 shrink-0 text-primary" />
              <div>
                <p className="font-bold">{x.t}</p>
                <p className="mt-1 text-sm text-muted-foreground">{x.d}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-7xl px-4 pb-20 sm:px-6">
        <div className="card card-gloss relative overflow-hidden p-10 text-center sm:p-14">
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-primary/12 via-transparent to-accent/10" />
          <h2 className="relative text-3xl font-extrabold tracking-tight sm:text-4xl">Stop guessing. Start knowing.</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-muted-foreground">Create your company in under a minute and see your real numbers today.</p>
          <Link href="/signup" className="btn btn-primary relative mt-7 !px-8 !py-3.5 !text-base">
            Create free account <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-6">
          <Logo />
          <p className="text-xs text-muted-foreground">© 2026 {brand.name}. {brand.tagline}.</p>
        </div>
      </footer>
    </div>
  );
}
