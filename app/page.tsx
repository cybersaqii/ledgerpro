import Link from "next/link";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, TrendingUp, Users, Wallet,
  Store, Factory, Stethoscope, Pill, UtensilsCrossed, Briefcase, Truck,
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

const businessTypes = [
  { icon: Boxes, label: "Wholesale" },
  { icon: Store, label: "Retail shops" },
  { icon: Truck, label: "Distribution" },
  { icon: Pill, label: "Pharmacy" },
  { icon: Stethoscope, label: "Clinics" },
  { icon: UtensilsCrossed, label: "Restaurants" },
  { icon: Briefcase, label: "Services" },
  { icon: Factory, label: "Manufacturing" },
];

const steps = [
  { n: "1", title: "Tell us your business", text: "Sign up with your shop details — your workspace adapts to your trade." },
  { n: "2", title: "Bill like always", text: "Create sale and purchase bills the way you already do." },
  { n: "3", title: "Watch it all add up", text: "Stock, cash, profit and dues update themselves." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-[#0a2e25]/85 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-[1400px] items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15 shadow-lg">
              <FileText size={18} className="text-white" />
            </span>
            <span>
              <span className="block text-[1.05rem] font-extrabold leading-none tracking-tight text-white">{brand.name}</span>
              <span className="block text-[0.68rem] text-emerald-100/70">{brand.tagline}</span>
            </span>
          </Link>
          <nav className="hidden items-center gap-7 text-sm font-semibold text-emerald-50/85 md:flex">
            <a href="#features" className="transition hover:text-white">Features</a>
            <a href="#businesses" className="transition hover:text-white">For every business</a>
            <a href="#how" className="transition hover:text-white">How it works</a>
          </nav>
          <div className="flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            <Link href="/login" className="hidden rounded-xl px-4 py-2 text-sm font-bold text-white transition hover:bg-white/10 sm:inline-flex">Log in</Link>
            <Link href="/signup" className="btn !border-0 !bg-white !px-4 !py-2 text-sm !text-[#0a2e25] hover:!bg-emerald-50">
              Start free <ArrowRight size={16} />
            </Link>
          </div>
        </div>
      </header>

      {/* Hero — rich dark */}
      <section className="relative">
        <div className="absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0b3d31]" />
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/4 h-[420px] w-[620px] rounded-full bg-emerald-400/20 blur-[130px]" />
          <div className="absolute top-1/3 -right-32 h-96 w-96 rounded-full bg-teal-300/15 blur-[110px]" />
          <div className="absolute inset-0 opacity-[0.06]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "30px 30px" }} />
          <div className="absolute inset-x-0 bottom-0 h-40 bg-gradient-to-t from-background to-transparent" />
        </div>
        <div className="relative mx-auto grid max-w-[1400px] items-center gap-12 px-4 pb-24 pt-32 sm:px-8 sm:pt-40 lg:grid-cols-2 lg:gap-8 lg:pb-32">
          <div className="text-center lg:text-left">
            <div className="rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-emerald-50 shadow-sm backdrop-blur">
              <Sparkles size={14} className="text-amber-300" />
              One platform — wholesale, retail & every business
            </div>
            <h1 className="rise rise-1 mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-[3.6rem]">
              Your entire business{" "}
              <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">hisaab</span>,
              finally in one place
            </h1>
            <p className="rise rise-2 mt-5 max-w-xl text-base text-emerald-50/80 sm:text-lg lg:mx-0">
              {brand.description} Sales, stock, payments and full double-entry accounts — tailored to your trade. No more registers, no more guesswork.
            </p>
            <div className="rise rise-3 mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link href="/signup" className="btn !border-0 !bg-white !px-7 !py-3.5 !text-base !text-[#0a2e25] shadow-xl shadow-black/20 hover:!bg-emerald-50">
                Start free today <ArrowRight size={18} />
              </Link>
              <Link href="/login" className="btn !border-white/25 !bg-white/10 !px-7 !py-3.5 !text-base !text-white backdrop-blur hover:!bg-white/20">
                Log in
              </Link>
            </div>
            <div className="rise rise-4 mt-10 flex items-center justify-center gap-8 text-emerald-50/70 lg:justify-start">
              {[
                ["10 yrs", "data safety"],
                ["100%", "balanced books"],
                ["Free", "to start"],
              ].map(([v, l]) => (
                <div key={l} className="text-center lg:text-left">
                  <p className="text-xl font-extrabold text-white">{v}</p>
                  <p className="text-xs">{l}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Floating dashboard mock */}
          <div className="rise rise-2 relative">
            <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-emerald-400/15 blur-3xl" />
            <div className="floaty card card-gloss relative p-5 text-left shadow-2xl sm:p-7">
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

      {/* Business types */}
      <section id="businesses" className="mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-20">
        <div className="text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Made for every business</h2>
          <p className="mx-auto mt-3 max-w-xl text-muted-foreground">Tell us your trade at signup — your workspace adapts. A retailer sees fast counter billing; a wholesaler sees bulk workflows.</p>
        </div>
        <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {businessTypes.map((b) => (
            <div key={b.label} className="card card-gloss flex items-center gap-3 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-primary-soft text-primary">
                <b.icon size={20} />
              </span>
              <p className="text-sm font-bold">{b.label}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Features */}
      <section id="features" className="mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-20">
        <div className="text-center">
          <h2 className="text-3xl font-extrabold tracking-tight sm:text-4xl">Everything your business needs</h2>
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
      <section id="how" className="border-y border-border bg-card/60">
        <div className="mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-20">
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
      <section className="mx-auto max-w-[1400px] px-4 py-14 sm:px-8">
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
      <section className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-8">
        <div className="relative overflow-hidden rounded-3xl p-10 text-center sm:p-14">
          <div className="absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0d7a5f]" />
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-20 left-1/3 h-72 w-72 rounded-full bg-emerald-400/20 blur-[100px]" />
          </div>
          <h2 className="relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Stop guessing. Start knowing.</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-emerald-50/80">Create your company in under a minute and see your real numbers today.</p>
          <Link href="/signup" className="btn relative mt-7 !border-0 !bg-white !px-8 !py-3.5 !text-base !text-[#0a2e25] shadow-xl hover:!bg-emerald-50">
            Create free account <ArrowRight size={18} />
          </Link>
        </div>
      </section>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-4 px-4 py-8 sm:flex-row sm:px-8">
          <Logo />
          <p className="text-xs text-muted-foreground">© 2026 {brand.name}. {brand.tagline}.</p>
        </div>
      </footer>
    </div>
  );
}
