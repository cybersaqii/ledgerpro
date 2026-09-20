import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import PubHeader from "../pub-header";
import TermsContent from "./content";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: `${brand.name} Terms of Service — your account, your data, fair use and liability.`,
};

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <TermsContent />
    </div>
  );
}
