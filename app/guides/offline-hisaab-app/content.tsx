import Link from "next/link";
import { WifiOff, ShoppingCart, Boxes, Wallet, BarChart3, RefreshCw, ArrowRight } from "lucide-react";
import { brand } from "@/lib/brand";

const WORKS_OFFLINE = [
  { icon: ShoppingCart, t: "Sales and purchases", d: "Create invoices, bills, returns and orders at the counter — no signal needed." },
  { icon: Boxes, t: "Stock", d: "Stock levels, godowns and low-stock warnings update on the device as you sell." },
  { icon: Wallet, t: "Payments and receipts", d: "Record cash and bank payments against bills; party balances update immediately." },
  { icon: BarChart3, t: "Reports", d: "Ageing, party ledgers, profit & loss and stock reports all run from on-device data." },
];

const FAQS = [
  {
    q: "Is the data really on my phone, or does it disappear when the app closes?",
    a: "It is stored on your device in the app&rsquo;s own database. Closing the app, restarting the phone or losing signal does not delete anything.",
  },
  {
    q: "How does syncing work when I am back online?",
    a: "On a plan that includes sync, the app sends your on-device data to your account when internet returns, so the same hisaab is available on the website and other devices. The pricing page lists which plan includes offline sync. The website version itself needs internet.",
  },
  {
    q: "What happens if two people bill offline on two phones?",
    a: "Each device keeps its own offline record and syncs when online. If the same record was changed on two devices, the sync keeps both versions visible rather than silently overwriting one — check the sync report before relying on merged numbers.",
  },
  {
    q: "Do I need internet to install the app?",
    a: "Yes, once — to download and install the Android app. After that, day-to-day billing works fully offline.",
  },
];

export default function OfflineContent() {
  const b = brand.name;
  return (
    <main>
      <section className="relative overflow-hidden bg-[#0a1120] text-white">
        <div className="relative mx-auto max-w-[1200px] px-4 py-16 sm:px-8 sm:py-24">
          <p className="text-xs font-extrabold uppercase tracking-widest text-amber-400">Guides · Offline</p>
          <h1 className="mt-4 max-w-2xl text-4xl font-extrabold tracking-tight sm:text-5xl">
            Offline hisaab app — your accounts keep working without internet
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-relaxed text-white/70 sm:text-lg">
            Load-shedding, weak signals in the godown, a market with no coverage — none of these
            should stop your billing. {b} for Android works fully offline and syncs when you are back online.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/download" className="btn !border-0 !bg-white !px-6 !py-3 !text-sm !text-[#101a2c] shadow-lg hover:!bg-slate-100">
              Get the Android app <ArrowRight size={15} />
            </Link>
            <Link href="/pricing" className="btn !border !border-white/30 !px-6 !py-3 !text-sm !text-white hover:!bg-white/10">
              See pricing
            </Link>
          </div>
        </div>
      </section>

      <section className="mx-auto max-w-[1200px] px-4 py-14 sm:px-8">
        <h2 className="text-2xl font-extrabold tracking-tight">What keeps working offline</h2>
        <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Everything a counter needs in a day. The app does not freeze, queue or refuse a bill
          because the internet is down.
        </p>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {WORKS_OFFLINE.map((c) => (
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
        <h2 className="text-2xl font-extrabold tracking-tight">What sync does — and what it does not</h2>
        <div className="mt-6 space-y-3 text-sm leading-relaxed text-muted-foreground">
          <p className="flex items-start gap-2">
            <RefreshCw size={16} className="mt-0.5 shrink-0 text-primary" />
            <span>
              When you are back online, a plan that includes sync sends the device data to your {b} account,
              so the website and your other devices show the same hisaab. Sync is a paid-plan feature —
              the offline app itself works on any plan. See the pricing page for which plan includes it.
            </span>
          </p>
          <p className="flex items-start gap-2">
            <WifiOff size={16} className="mt-0.5 shrink-0 text-primary" />
            <span>
              The website version of {b} needs internet, like any website. If your shop often loses
              connectivity, do the day&rsquo;s billing in the Android app and use the website where the
              connection is stable.
            </span>
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
          Related: <Link href="/guides/wholesale-hisaab-software" className="font-bold text-primary hover:underline">wholesale hisaab guide</Link> ·{" "}
          <Link href="/guides/hisaab-software-price-pakistan" className="font-bold text-primary hover:underline">price guide</Link>.
        </p>
      </section>
    </main>
  );
}
