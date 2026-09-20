"use client";

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { getBusinessProfile, type BusinessProfile } from "@/lib/business-types";
import { useLang } from "./lang-provider";
import { tr } from "@/lib/i18n";

const BusinessTypeContext = createContext<BusinessProfile>(getBusinessProfile(undefined));

/** Wraps the authenticated app; every page below reads its vocabulary from here. */
export function BusinessTypeProvider({
  businessType,
  children,
}: {
  businessType: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <BusinessTypeContext.Provider value={getBusinessProfile(businessType)}>
      {children}
    </BusinessTypeContext.Provider>
  );
}

const BP_FIELDS = [
  "partyOne", "partyMany", "productOne", "productMany",
  "salesNav", "newSale", "saveSale", "receivables", "stock",
] as const;

/** Language-aware profile for places that sit outside the provider (e.g. AppShell nav). */
export function getTranslatedProfile(businessType: string | null | undefined, lang: "en" | "ur"): BusinessProfile {
  const base = getBusinessProfile(businessType);
  if (lang === "en") return base;
  const out = { ...base };
  for (const f of BP_FIELDS) {
    const key = `bp.${base.type}.${f}`;
    const v = tr("ur", key);
    if (v !== key) (out as unknown as Record<string, string>)[f] = v;
  }
  return out;
}

/**
 * The current company's adaptive vocabulary (party/product/sales labels),
 * translated to the active UI language.
 */
export function useBusinessProfile(): BusinessProfile {
  const base = useContext(BusinessTypeContext);
  const { lang } = useLang();
  return useMemo(() => getTranslatedProfile(base.type, lang), [base, lang]);
}
