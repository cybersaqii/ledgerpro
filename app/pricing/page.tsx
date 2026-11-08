import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import PubHeader from "../pub-header";
import PubFooter from "../pub-footer";
import PricingSection from "@/components/pricing-section";

export const metadata: Metadata = {
  title: `Pricing in PKR — Starter, Professional & Enterprise`,
  description: `LedgerProSolution pricing in Pakistani rupees: Starter Rs 1,500, Professional Rs 2,000, Enterprise Rs 3,500 per month. Start with a 30-day free trial, upgrade only when your business needs more.`,
  alternates: { canonical: "/pricing" },
};

/**
 * Standalone pricing page (QA sweep 2026-11-01: /pricing used to redirect
 * to the landing anchor). Same section as the landing page, under the
 * shared public header (brand home link + login cover navigation).
 */
export default function PricingPage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <main>
        <PricingSection />
      </main>
      <PubFooter />
    </div>
  );
}
