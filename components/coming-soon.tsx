"use client";

import { Rocket } from "lucide-react";
import { Breadcrumb, PageHeader, EmptyState } from "@/components/ui";
import { useLang } from "@/components/lang-provider";

/** Placeholder page for sections that are not implemented yet.
 *  Renders the Fast Accounts-style breadcrumb + title so navigation stays consistent. */
export function ComingSoon({ section, title }: { section: string; title: string }) {
  const { t } = useLang();
  return (
    <div>
      <Breadcrumb
        items={[
          { label: t("nav.home"), href: "/dashboard" },
          { label: section },
          { label: title },
        ]}
      />
      <PageHeader title={title} icon={<Rocket size={20} />} />
      <EmptyState
        title={t("nav.comingSoon")}
        hint={t("nav.comingSoonHint")}
        icon={<Rocket size={26} />}
      />
    </div>
  );
}
