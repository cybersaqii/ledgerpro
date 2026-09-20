"use client";

import Link from "next/link";
import { LifeBuoy, Mail, Phone, Clock } from "lucide-react";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";
import SupportForm from "./form";

export default function SupportContent({ email, phone, hours }: { email: string; phone: string; hours: string }) {
  const { t } = useLang();
  const cards = [
    { icon: Mail, label: t("support.emailLabel"), value: email, href: email ? `mailto:${email}` : undefined },
    ...(phone ? [{ icon: Phone, label: t("support.phoneLabel"), value: phone, href: `tel:${phone.replace(/\s/g, "")}` }] : []),
    ...(hours ? [{ icon: Clock, label: t("support.hoursLabel"), value: hours, href: undefined as string | undefined }] : []),
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
          <Link href="/login" className="text-sm font-bold text-emerald-100/80 transition hover:text-white">{t("pub.login")}</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-12 sm:px-8">
        <h1 className="text-3xl font-extrabold tracking-tight">{t("support.title")}</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">{t("support.intro")}</p>

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
          <h2 className="text-lg font-extrabold">{t("support.formTitle")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t("support.formSub")}</p>
          <SupportForm />
        </div>

        <p className="mt-12 border-t border-border pt-6 text-center text-sm">
          <Link href="/changelog" className="font-bold text-primary hover:underline">{t("support.changelogLink")}</Link>
          <span className="mx-3 text-muted-foreground">·</span>
          <Link href="/" className="font-bold text-primary hover:underline">{t("pub.backHome")}</Link>
        </p>
      </main>
    </div>
  );
}
