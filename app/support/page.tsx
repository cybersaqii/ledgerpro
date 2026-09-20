import type { Metadata } from "next";
import Link from "next/link";
import { LifeBuoy, Mail, Phone, Clock } from "lucide-react";
import { brand } from "@/lib/brand";
import { getPlatformSettings } from "@/lib/billing-guards";
import { SUPPORT_DEFAULTS } from "@/lib/support";
import SupportForm from "./form";

export const metadata: Metadata = {
  title: "Support",
  description: `Get help with ${brand.name} — contact details and a support request form.`,
};

// Contact details come from the database so the platform admin can change
// them without a deploy; never prerender at build time.
export const dynamic = "force-dynamic";

function setting(all: Record<string, string>, key: string): string {
  return all[key] || SUPPORT_DEFAULTS[key] || "";
}

export default async function SupportPage() {
  let all: Record<string, string> = {};
  try {
    all = await getPlatformSettings();
  } catch {
    all = {};
  }
  const email = setting(all, "support.email");
  const phone = setting(all, "support.phone");
  const hours = setting(all, "support.hours");

  const cards = [
    { icon: Mail, label: "Email", value: email, href: email ? `mailto:${email}` : undefined },
    ...(phone ? [{ icon: Phone, label: "Phone / WhatsApp", value: phone, href: `tel:${phone.replace(/\s/g, "")}` }] : []),
    ...(hours ? [{ icon: Clock, label: "Support hours", value: hours, href: undefined as string | undefined }] : []),
  ];

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-white/10 bg-[#0a2e25]">
        <div className="mx-auto flex h-16 max-w-4xl items-center justify-between px-4 sm:px-8">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-xl bg-white/15">
              <LifeBuoy size={18} className="text-white" />
            </span>
            <span className="text-[1.05rem] font-extrabold tracking-tight text-white">{brand.name}</span>
          </Link>
          <Link href="/login" className="text-sm font-bold text-emerald-100/80 transition hover:text-white">Log in</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">Support</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          Stuck on something? Reach us directly on the channels below, or send a message with the form —
          we read every request and reply through the contact details listed here.
        </p>

        <div className="mt-8 grid gap-4 sm:grid-cols-3">
          {cards.map((c) => (
            <div key={c.label} className="card p-5">
              <span className="grid h-10 w-10 place-items-center rounded-2xl bg-primary-soft text-primary">
                <c.icon size={19} />
              </span>
              <p className="mt-3 text-xs font-extrabold uppercase tracking-wider text-muted-foreground">{c.label}</p>
              {c.href ? (
                <a href={c.href} className="mt-1 block break-words text-sm font-bold text-primary hover:underline">{c.value}</a>
              ) : (
                <p className="mt-1 text-sm font-bold">{c.value}</p>
              )}
            </div>
          ))}
        </div>

        <div className="card mt-8 p-6 sm:p-8">
          <h2 className="text-lg font-extrabold">Send a support request</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Tell us what happened and how to reach you. Requests are answered by our team via email or phone —
            there are no automated replies, so please allow some time during support hours.
          </p>
          <SupportForm />
        </div>

        <p className="mt-12 border-t border-border pt-6 text-center text-sm">
          <Link href="/changelog" className="font-bold text-primary hover:underline">Changelog</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">Back to home</Link>
        </p>
      </main>
    </div>
  );
}
