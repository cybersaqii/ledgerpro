import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import PubHeader from "../pub-header";
import PricingSection from "@/components/pricing-section";

export const metadata: Metadata = {
  title: `Pricing — ${brand.name}`,
  description: `Honest pricing in rupees for ${brand.name}: Free, Starter, Professional and Enterprise plans. Start free, upgrade only when your business needs more.`,
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
    </div>
  );
}
