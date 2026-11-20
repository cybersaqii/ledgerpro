import type { Metadata } from "next";
import PubHeader from "../../pub-header";
import PubFooter from "../../pub-footer";
import OfflineContent from "./content";

export const metadata: Metadata = {
  title: "Offline Hisaab App — Accounts Without Internet",
  description: `Load-shedding and weak signals should not stop your billing. How the LedgerPro offline hisaab app keeps sales, stock and payments working with no internet — and what syncs when you are back online.`,
  alternates: { canonical: "/guides/offline-hisaab-app" },
};

export default function OfflineGuidePage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <OfflineContent />
      <PubFooter />
    </div>
  );
}
