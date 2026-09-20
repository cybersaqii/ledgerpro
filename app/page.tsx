import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import LandingContent from "./landing-content";

export const metadata: Metadata = {
  title: "Free Accounting Software for Every Business",
  description:
    "Sales, purchases, stock, POS, payments and profit reports — double-entry hisaab-kitab tailored to your trade. Free to start, no credit card needed.",
  alternates: { canonical: "/" },
  openGraph: {
    title: `${brand.name} — ${brand.tagline}`,
    description: "Sales, stock, udhaar, cash and profit — your entire business hisaab, finally in one place. Free to start.",
    url: "/",
  },
};

export default function LandingPage() {
  return <LandingContent />;
}
