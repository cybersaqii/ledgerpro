import type { Metadata } from "next";
import PubHeader from "../../pub-header";
import PubFooter from "../../pub-footer";
import PriceContent from "./content";

export const metadata: Metadata = {
  title: "Hisaab Software Price in Pakistan — What Should You Pay?",
  description: `LedgerProSolution pricing in Pakistani rupees: Starter Rs 1,500, Professional Rs 2,000, Enterprise Rs 3,500 per month, with a 30-day free trial. What each plan covers and what to check before you pay.`,
  alternates: { canonical: "/guides/hisaab-software-price-pakistan" },
};

export default function PriceGuidePage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <PriceContent />
      <PubFooter />
    </div>
  );
}
