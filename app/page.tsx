import Link from "next/link";
import {
  ArrowRight, BarChart3, Boxes, CheckCircle2, FileText, Landmark,
  ScanBarcode, ShieldCheck, Smartphone, Sparkles, ReceiptText, TrendingUp, Users, Wallet,
  Store, Factory, Stethoscope, Pill, UtensilsCrossed, Briefcase, Truck,
  TriangleAlert, XCircle, BadgeCheck,
} from "lucide-react";
import { ThemeToggle } from "@/components/ui";
import { brand } from "@/lib/brand";

const features = [
  { icon: FileText, title: "Sales & purchase bills", text: "Invoices, returns, quotations and orders with automatic double-entry posting behind every document." },
  { icon: Boxes, title: "Smart stock control", text: "Quantities, average-cost valuation and low-stock tracking for your business." },
  { icon: Wallet, title: "Payments & receipts", text: "Allocate every receipt against invoices. Know exactly who owes you — and who you owe — at any second." },
  { icon: BarChart3, title: "Reports that matter", text: "Profit & loss, balance sheet, trial balance, party ledgers and stock valuation in one click." },
  { icon: ScanBarcode, title: "Fast billing", text: "Search products by name or SKU and build a bill in seconds — even on a phone." },
  { icon: ShieldCheck, title: "Safe for up to 10 years", text: "Every entry is balanced and permanent. Your complete business history, always verifiable." },
  { icon: Users, title: "Parties & credit limits", text: "Customers and suppliers with balances, credit limits and full transaction history." },
  { icon: Landmark, title: "Cash & bank", text: "Track every cash drawer, bank account and wallet with automatic balance updates." },
  { icon: Smartphone, title: "Works everywhere", text: "Fast on mobile, tablet and desktop. Light and dark mode included." },
];

const businessTypes = [
  { icon: Boxes, label: "Wholesale", grad: "from-emerald-500 to-teal-600", glow: "group-hover:shadow-emerald-500/30" },
  { icon: Store, label: "Retail shops", grad: "from-amber-500 to-orange-600", glow: "group-hover:shadow-amber-500/30" },
  { icon: Truck, label: "Distribution", grad: "from-blue-500 to-indigo-600", glow: "group-hover:shadow-blue-500/30" },
  { icon: Pill, label: "Pharmacy", grad: "from-cyan-500 to-sky-600", glow: "group-hover:shadow-cyan-500/30" },
  { icon: Stethoscope, label: "Clinics", grad: "from-rose-500 to-pink-600", glow: "group-hover:shadow-rose-500/30" },
  { icon: UtensilsCrossed, label: "Restaurants", grad: "from-orange-500 to-red-500", glow: "group-hover:shadow-orange-500/30" },
  { icon: Briefcase, label: "Services", grad: "from-violet-500 to-purple-600", glow: "group-hover:shadow-violet-500/30" },
  { icon: Factory, label: "Manufacturing", grad: "from-slate-500 to-slate-700", glow: "group-hover:shadow-slate-500/30" },
];

const featureGrads = [
  "from-emerald-500 to-teal-600",
  "from-amber-500 to-orange-600",
  "from-blue-500 to-indigo-600",
  "from-cyan-500 to-sky-600",
  "from-rose-500 to-pink-600",
  "from-violet-500 to-purple-600",
];

const steps = [
  { n: "1", title: "Tell us your business", text: "Sign up with your shop details — your workspace adapts to your trade." },
  { n: "2", title: "Bill like always", text: "Create sale and purchase bills the way you already do." },
  { n: "3", title: "Watch it all add up", text: "Stock, cash, profit and dues update themselves." },
];

const faqs = [
  { q: "Is LedgerPro really free?", a: "Yes — creating your company and getting started is free, and you never need a credit card to try it. Set up in about two minutes and see your real numbers the same day." },
  { q: "I've never used accounting software. Will I manage?", a: "Absolutely. LedgerPro speaks your language — Sale, Payment, Stock — not accounting jargon. Guided forms walk you through every step, and every rupee is double-checked behind the scenes." },
  { q: "Is my business data safe?", a: "Your company is protected by a secure login, every entry uses balanced double-entry accounting (so the books can never silently go wrong), and your complete history stays safe for up to 10 years." },
  { q: "Can I use it on my phone?", a: "Yes. LedgerPro works on your phone, tablet and computer, with light and dark mode — bill a customer at the counter or check dues from home." },
  { q: "What kinds of businesses is it for?", a: "Wholesalers, retail shops, distributors, pharmacies, clinics, restaurants, service providers and manufacturers. Tell us your trade at signup and your workspace adapts to it." },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-background">
      {/* Nav */}
      <header className="fixed inset-x-0 top-0 z-40 border-b border-white/10 bg-[#0a2e25]/85 backdrop-blur-xl">
        <div className="flex h-16 items-center justify-between px-4 sm:px-8 lg:px-12">
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
            <a href="#faq" className="transition hover:text-white">FAQ</a>
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
          <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-background to-transparent" />
        </div>
        <div className="relative grid items-center gap-12 px-4 pb-16 pt-32 sm:px-8 sm:pt-40 lg:grid-cols-2 lg:gap-12 lg:px-12 lg:pb-20">
          <div className="text-center lg:text-left">
            <div className="rise inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-semibold text-emerald-50 shadow-sm backdrop-blur">
              <BadgeCheck size={14} className="text-amber-300" />
              Free to start · No credit card needed
            </div>
            <h1 className="rise rise-1 mt-6 text-4xl font-extrabold leading-[1.06] tracking-tight text-white sm:text-6xl lg:text-[3.6rem]">
              Your entire business{" "}
              <span className="bg-gradient-to-r from-amber-300 to-emerald-300 bg-clip-text text-transparent">hisaab</span>,
              finally in one place
            </h1>
            <p className="rise rise-2 mt-5 max-w-xl text-base text-emerald-50/80 sm:text-lg lg:mx-0">
              Stop losing money to forgotten <span className="font-semibold text-white">udhaar</span> and guesswork.
              LedgerPro tracks every sale, payment and stock item — and tells you exactly who owes you what, in seconds.
            </p>
            <ul className="rise rise-3 mx-auto mt-7 grid max-w-xl gap-2.5 text-left sm:grid-cols-2 lg:mx-0">
              {[
                "Every customer's udhaar, one tap away",
                "Stock, cash & profit update themselves",
                "No accounting knowledge needed",
                "Your data stays safe for up to 10 years",
              ].map((t) => (
                <li key={t} className="flex items-start gap-2 text-sm font-medium text-emerald-50">
                  <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-300" />
                  {t}
                </li>
              ))}
            </ul>
            <div className="rise rise-4 mt-8 flex flex-wrap items-center justify-center gap-3 lg:justify-start">
              <Link href="/signup" className="btn !border-0 !bg-white !px-7 !py-3.5 !text-base !text-[#0a2e25] shadow-xl shadow-black/20 hover:!bg-emerald-50">
                Start free today <ArrowRight size={18} />
              </Link>
              <Link href="/login" className="btn !border-white/25 !bg-white/10 !px-7 !py-3.5 !text-base !text-white backdrop-blur hover:!bg-white/20">
                Log in
              </Link>
            </div>
            <p className="rise rise-4 mt-4 text-xs text-emerald-100/60">
              Set up in 2 minutes · Free to start · No credit card needed
            </p>
          </div>

          {/* Floating dashboard mock */}
          <div className="rise rise-2 relative lg:pl-6">
            <div className="pointer-events-none absolute -inset-6 rounded-[2rem] bg-emerald-400/15 blur-3xl" />
            {/* Floating proof card — payment */}
            <div className="floaty absolute -top-6 right-2 z-10 hidden items-center gap-3 rounded-2xl border border-white/40 bg-white/95 p-3 pr-4 shadow-xl backdrop-blur md:flex">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-emerald-700">
                <CheckCircle2 size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-900">Payment received</span>
                <span className="block text-[0.7rem] text-slate-500">Rs 25,000 · Ahmed Traders · just now</span>
              </span>
            </div>
            {/* Floating proof card — stock alert */}
            <div className="floaty absolute -bottom-7 left-0 z-10 hidden items-center gap-3 rounded-2xl border border-white/40 bg-white/95 p-3 pr-4 shadow-xl backdrop-blur md:flex" style={{ animationDelay: "-3.5s" }}>
              <span className="grid h-10 w-10 place-items-center rounded-full bg-amber-100 text-amber-700">
                <TriangleAlert size={20} />
              </span>
              <span>
                <span className="block text-xs font-bold text-slate-900">Low stock alert</span>
                <span className="block text-[0.7rem] text-slate-500">Sugar 50kg · only 8 bags left</span>
              </span>
            </div>
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
        {/* Business-type marquee — fills the hero foot with motion */}
        <div className="relative z-10 border-t border-white/10 py-6">
          <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
            <div className="animate-marquee flex w-max items-center gap-10 pr-10">
              {[...businessTypes, ...businessTypes].map((b, i) => (
                <span key={i} className="flex items-center gap-2 text-sm font-semibold tracking-wide text-emerald-50">
                  <b.icon size={16} className="text-emerald-300" />
                  {b.label}
                </span>
              ))}
            </div>
          </div>
        </div>
        {/* Spacer so the bottom fade blends below the marquee */}
        <div className="relative h-14" />
      </section>

      {/* Paper vs LedgerPro — loss aversion */}
      <section className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -left-24 top-10 h-72 w-72 rounded-full bg-emerald-300/25 blur-[100px]" />
          <div className="absolute -right-24 bottom-10 h-72 w-72 rounded-full bg-amber-200/40 blur-[100px]" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-500/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-red-600">
              <TriangleAlert size={13} /> Why switch
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">Still running on paper registers?</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">Here is what paper quietly costs you — every single day.</p>
          </div>
          <div className="mx-auto mt-10 grid max-w-4xl gap-5 md:grid-cols-2 md:gap-6">
            <div className="rounded-3xl border border-border bg-card/80 p-7 shadow-sm backdrop-blur transition hover:shadow-md sm:p-8">
              <p className="text-sm font-bold uppercase tracking-wider text-muted-foreground">Paper register</p>
              <ul className="mt-5 space-y-3.5">
                {[
                  "Udhaar forgotten — money you will never collect",
                  "Stock counted by memory — overbuying and shortages",
                  "No idea of your real profit at month end",
                  "One lost register wipes out years of history",
                ].map((t) => (
                  <li key={t} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                    <XCircle size={17} className="mt-0.5 shrink-0 text-red-400" /> {t}
                  </li>
                ))}
              </ul>
            </div>
            <div className="rounded-3xl bg-gradient-to-br from-emerald-500 via-teal-500 to-emerald-600 p-[2px] shadow-xl shadow-emerald-500/20 transition hover:shadow-2xl hover:shadow-emerald-500/30">
              <div className="relative h-full rounded-[calc(1.5rem-2px)] bg-card p-7 sm:p-8">
                <span className="absolute -top-3.5 left-6 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 px-3.5 py-1 text-[0.68rem] font-extrabold uppercase tracking-wider text-white shadow-md">Recommended</span>
                <p className="bg-gradient-to-r from-emerald-600 to-teal-600 bg-clip-text text-sm font-extrabold uppercase tracking-wider text-transparent">{brand.name}</p>
                <ul className="mt-5 space-y-3.5">
                  {[
                    "Every rupee tracked — nothing ever slips away",
                    "Live stock with low-stock alerts",
                    "Profit, dues and cash in one click",
                    "Up to 10 years of balanced, verifiable history",
                  ].map((t) => (
                    <li key={t} className="flex items-start gap-2.5 text-sm font-medium">
                      <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-600" /> {t}
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn btn-primary !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              Make the switch — it&apos;s free <ArrowRight size={18} />
            </Link>
            <p className="mt-3 text-xs text-muted-foreground">Your paper register stays as backup while you try it.</p>
          </div>
        </div>
      </section>
      <section id="businesses" className="relative overflow-hidden">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/2 top-0 h-64 w-[42rem] -translate-x-1/2 rounded-full bg-emerald-200/30 blur-[110px]" />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Sparkles size={13} /> Built for your trade
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">Made for every business</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">Tell us your trade at signup — your workspace adapts to it. A clinic sees Patients and Treatments; a wholesaler sees Parties and Products — one reliable hisaab engine underneath.</p>
          </div>
          <div className="mt-10 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
            {businessTypes.map((b) => (
              <div key={b.label} className={`card group flex items-center gap-2.5 p-3 transition duration-300 hover:-translate-y-1 hover:shadow-xl ${b.glow} sm:gap-3 sm:p-5`}>
                <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${b.grad} text-white shadow-md sm:h-12 sm:w-12`}>
                  <b.icon size={18} className="sm:h-[21px] sm:w-[21px]" />
                </span>
                <p className="min-w-0 flex-1 break-words text-[0.8rem] font-bold leading-tight sm:text-sm">{b.label}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="relative overflow-hidden bg-gradient-to-b from-background via-emerald-50/50 to-background dark:via-emerald-950/20">
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <Boxes size={13} /> Full toolkit
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">Everything your business needs</h2>
            <p className="mx-auto mt-3 max-w-xl text-muted-foreground">From the first purchase bill to the final profit report — {brand.name} handles the full cycle.</p>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {features.map((f, i) => (
              <div key={f.title} className="card card-gloss group p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl hover:shadow-primary/10">
                <span className={`grid h-12 w-12 place-items-center rounded-2xl bg-gradient-to-br ${featureGrads[i % featureGrads.length]} text-white shadow-md transition group-hover:scale-110`}>
                  <f.icon size={22} />
                </span>
                <h3 className="mt-4 text-base font-bold">{f.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{f.text}</p>
              </div>
            ))}
          </div>
          <div className="mt-10 text-center">
            <Link href="/signup" className="btn btn-primary !px-8 !py-3.5 !text-base shadow-lg shadow-primary/30">
              Try every feature free <ArrowRight size={18} />
            </Link>
          </div>
        </div>
      </section>

      {/* Steps — dark band */}
      <section id="how" className="relative overflow-hidden bg-[#0a2e25]">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-24 left-1/4 h-72 w-[36rem] rounded-full bg-emerald-400/15 blur-[110px]" />
          <div className="absolute -bottom-24 right-1/4 h-72 w-[36rem] rounded-full bg-teal-300/10 blur-[110px]" />
          <div className="absolute inset-0 opacity-[0.05]" style={{ backgroundImage: "radial-gradient(circle at 1px 1px, #fff 1px, transparent 0)", backgroundSize: "28px 28px" }} />
        </div>
        <div className="relative mx-auto max-w-[1400px] px-4 py-16 sm:px-8 sm:py-24">
          <div className="text-center">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-white/15 bg-white/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-emerald-100">
              <Smartphone size={13} /> How it works
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Up and running in three steps</h2>
            <p className="mx-auto mt-3 max-w-xl text-emerald-100/70">No training, no setup headaches — most owners bill their first customer within minutes.</p>
          </div>
          <div className="relative mx-auto mt-12 grid max-w-5xl gap-5 md:grid-cols-3">
            <div className="pointer-events-none absolute left-[16%] right-[16%] top-10 hidden border-t-2 border-dashed border-white/15 md:block" aria-hidden />
            {steps.map((s) => (
              <div key={s.n} className="relative rounded-3xl border border-white/10 bg-white/[0.06] p-7 text-center backdrop-blur transition hover:bg-white/[0.09]">
                <span className="relative mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-amber-300 to-emerald-400 text-xl font-extrabold text-[#0a2e25] shadow-lg shadow-black/20">{s.n}</span>
                <h3 className="mt-5 text-base font-bold text-white">{s.title}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-emerald-100/70">{s.text}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Trust strip */}
      <section className="relative overflow-hidden">
        <div className="relative mx-auto max-w-[1400px] px-4 py-14 sm:px-8">
          <div className="grid gap-4 sm:grid-cols-3">
            {[
              { t: "Double-entry core", d: "Every rupee is debited and credited. Books always balance.", icon: Landmark, grad: "from-emerald-500 to-teal-600" },
              { t: "Beginner friendly", d: "Simple words, guided forms — no accounting degree needed.", icon: Users, grad: "from-amber-500 to-orange-600" },
              { t: "Your data stays yours", d: "Secure company login. Your business stays private.", icon: ShieldCheck, grad: "from-blue-500 to-indigo-600" },
            ].map((x) => (
              <div key={x.t} className="group flex items-start gap-4 rounded-3xl border border-border bg-card p-6 transition duration-300 hover:-translate-y-1 hover:shadow-xl">
                <span className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl bg-gradient-to-br ${x.grad} text-white shadow-md transition group-hover:scale-110`}>
                  <x.icon size={21} />
                </span>
                <div>
                  <p className="font-bold">{x.t}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{x.d}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ — objection handling */}
      <section id="faq" className="relative overflow-hidden bg-gradient-to-b from-background via-emerald-50/40 to-background dark:via-emerald-950/10">
        <div className="relative mx-auto grid max-w-[1400px] gap-10 px-4 py-16 sm:px-8 sm:py-24 lg:grid-cols-[1fr_1.5fr]">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-4 py-1.5 text-xs font-bold uppercase tracking-wider text-primary">
              <CheckCircle2 size={13} /> FAQ
            </span>
            <h2 className="mt-4 text-3xl font-extrabold tracking-tight sm:text-4xl">Questions?<br />Answered.</h2>
            <p className="mt-3 max-w-sm text-muted-foreground">Everything business owners ask before switching from paper to {brand.name}.</p>
            <Link href="/signup" className="btn btn-primary mt-6 !px-6 !py-3 text-sm shadow-lg shadow-primary/25">
              Start free today <ArrowRight size={16} />
            </Link>
          </div>
          <div className="space-y-3">
            {faqs.map((f) => (
              <details key={f.q} className="card group px-6 py-5 transition hover:border-primary/40">
                <summary className="flex cursor-pointer items-center justify-between gap-4 font-bold [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 text-xl leading-none text-white shadow transition group-open:rotate-45">+</span>
                </summary>
                <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="mx-auto max-w-[1400px] px-4 pb-20 sm:px-8">
        <div className="relative overflow-hidden rounded-3xl p-10 text-center sm:p-14">
          <div className="absolute inset-0 bg-gradient-to-br from-[#0a2e25] via-[#0d4a3a] to-[#0d7a5f]" />
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -top-20 left-1/3 h-72 w-72 rounded-full bg-emerald-400/20 blur-[100px]" />
          </div>
          <h2 className="relative text-3xl font-extrabold tracking-tight text-white sm:text-4xl">Every day on paper is money you can&apos;t track.</h2>
          <p className="relative mx-auto mt-3 max-w-lg text-emerald-50/80">Join {brand.name} free — see your real sales, stock, dues and profit today.</p>
          <Link href="/signup" className="btn relative mt-7 !border-0 !bg-white !px-8 !py-3.5 !text-base !text-[#0a2e25] shadow-xl hover:!bg-emerald-50">
            Create free account <ArrowRight size={18} />
          </Link>
          <p className="relative mt-4 text-xs text-emerald-100/60">Free to start · No credit card · Set up in 2 minutes</p>
        </div>
      </section>

      <footer className="relative overflow-hidden bg-[#0a2e25] text-emerald-50">
        <div className="pointer-events-none absolute inset-0">
          <div className="absolute -top-32 left-1/3 h-64 w-[38rem] rounded-full bg-emerald-400/10 blur-[110px]" />
        </div>
        <div className="relative mx-auto grid max-w-[1400px] gap-10 px-4 py-14 sm:px-8 md:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white shadow-lg">
                <ReceiptText size={20} />
              </span>
              <div className="leading-tight">
                <p className="text-lg font-extrabold tracking-tight text-white">{brand.name}</p>
                <p className="text-[0.68rem] font-medium text-emerald-200/60">{brand.tagline}</p>
              </div>
            </div>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-emerald-100/60">Sales, stock, udhaar, cash and profit — your entire business hisaab, finally in one place. Free to start, no credit card needed.</p>
            <Link href="/signup" className="btn mt-5 !border-0 !bg-white !px-6 !py-2.5 !text-sm !text-[#0a2e25] shadow-lg hover:!bg-emerald-50">
              Start free <ArrowRight size={16} />
            </Link>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-200/60">Product</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {[["Features", "#features"], ["For every business", "#businesses"], ["How it works", "#how"], ["FAQ", "#faq"], ["Log in", "/login"]].map(([t, h]) => (
                <li key={h}><Link href={h} className="text-emerald-100/75 transition hover:text-white">{t}</Link></li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-xs font-extrabold uppercase tracking-wider text-emerald-200/60">Made for</p>
            <ul className="mt-4 space-y-2.5 text-sm">
              {["Wholesale", "Retail shops", "Pharmacy", "Clinics", "Restaurants", "Services"].map((t) => (
                <li key={t} className="text-emerald-100/75">{t}</li>
              ))}
            </ul>
          </div>
        </div>
        <div className="relative border-t border-white/10">
          <div className="mx-auto flex max-w-[1400px] flex-col items-center justify-between gap-2 px-4 py-5 text-xs text-emerald-100/50 sm:flex-row sm:px-8">
            <p>© 2026 {brand.name}. All rights reserved.</p>
            <p>Complete hisaab-kitab for every business.</p>
          </div>
        </div>
      </footer>
    </div>
  );
}
