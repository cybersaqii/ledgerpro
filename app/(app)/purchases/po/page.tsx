"use client";
import { ComingSoon } from "@/components/coming-soon";
import { useLang } from "@/components/lang-provider";

export default function PurchaseOrdersPage() {
  const { t } = useLang();
  return <ComingSoon section={t("nav.groupPurchases")} title={t("nav.po")} />;
}
