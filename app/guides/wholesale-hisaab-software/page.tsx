import type { Metadata } from "next";
import PubHeader from "../../pub-header";
import PubFooter from "../../pub-footer";
import WholesaleContent from "./content";

export const metadata: Metadata = {
  title: "Wholesale Hisaab Software for Pakistani Wholesalers",
  description: `How wholesale traders in Pakistan keep udhaar, stock and party ledgers in one place — and what to look for in a hisaab app before you switch from the register.`,
  alternates: { canonical: "/guides/wholesale-hisaab-software" },
};

export default function WholesaleGuidePage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <WholesaleContent />
      <PubFooter />
    </div>
  );
}
