import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import LandingContent from "./landing-content";
import StructuredData from "./structured-data";

export const metadata: Metadata = {
  title: "Free Accounting Software in Pakistan",
  description:
    "Double-entry hisaab-kitab for Pakistani businesses — sales, purchases, stock, POS, udhaar and profit reports. Free to start, no credit card needed.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${brand.name} — ${brand.tagline}`,
    description: "Sales, stock, udhaar, cash and profit — your entire business hisaab, finally in one place. Free to start.",
    url: "/",
  },
};

export default function LandingPage() {
  return (
    <>
      <StructuredData />
      <LandingContent />
    </>
  );
}
