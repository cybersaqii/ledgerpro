import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import PubHeader from "../pub-header";
import PrivacyContent from "./content";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: `${brand.name} Privacy Policy — what we collect, how we use it, and your rights to your data.`,
};

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <PrivacyContent />
    </div>
  );
}
