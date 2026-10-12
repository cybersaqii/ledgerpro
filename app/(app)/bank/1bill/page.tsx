"use client";
import { ComingSoon } from "@/components/coming-soon";
import { useLang } from "@/components/lang-provider";

export default function OneBillPage() {
  const { t } = useLang();
  return <ComingSoon section={t("nav.groupBank")} title={t("nav.oneBill")} />;
}
