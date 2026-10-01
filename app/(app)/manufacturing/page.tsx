"use client";

import Link from "next/link";
import { Cog, ClipboardList, ArrowRight } from "lucide-react";
import { PageHeader } from "@/components/ui";
import { useLang } from "@/components/lang-provider";
import { usePermissions } from "@/components/permissions";

export default function ManufacturingPage() {
  const { t } = useLang();
  const { permissions, loading } = usePermissions();
  const canSee = loading || permissions.includes("manufacturing");
  if (!canSee) return null;

  const cards = [
    {
      href: "/manufacturing/work-orders",
      icon: ClipboardList,
      title: t("mfg.tabWorkOrders"),
      hint: "MWO-0001 · DRAFT → RELEASED → IN_PROGRESS → COMPLETED",
    },
    {
      href: "/manufacturing/boms",
      icon: Cog,
      title: t("mfg.tabBoms"),
      hint: t("mfg.singleLevelNote"),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title={t("mfg.title")} subtitle={t("mfg.subtitle")} />
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="group rounded-2xl border border-border bg-card p-5 transition hover:border-primary"
          >
            <div className="flex items-start justify-between">
              <span className="rounded-xl bg-primary/10 p-2.5 text-primary">
                <c.icon className="h-6 w-6" />
              </span>
              <ArrowRight className="h-5 w-5 text-muted-foreground transition group-hover:translate-x-1 rtl:rotate-180" />
            </div>
            <h2 className="mt-3 text-lg font-extrabold">{c.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{c.hint}</p>
          </Link>
        ))}
      </div>
      <div className="mt-6 rounded-2xl border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        <p className="font-bold text-foreground">{t("mfg.wip")}</p>
        <ul className="mt-2 list-disc space-y-1 ps-5 text-xs">
          <li>{t("mfg.wipHint")}</li>
          <li>{t("mfg.laborPayableHint")}</li>
          <li>{t("mfg.overheadHint")}</li>
          <li>{t("mfg.actualCostNote")}</li>
        </ul>
      </div>
    </div>
  );
}
