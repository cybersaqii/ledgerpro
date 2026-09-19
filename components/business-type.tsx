"use client";

import { createContext, useContext, type ReactNode } from "react";
import { getBusinessProfile, type BusinessProfile } from "@/lib/business-types";

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

/** The current company's adaptive vocabulary (party/product/sales labels). */
export function useBusinessProfile(): BusinessProfile {
  return useContext(BusinessTypeContext);
}
