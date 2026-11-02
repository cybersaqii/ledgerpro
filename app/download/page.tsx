import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import DownloadContent from "./content";

export const metadata: Metadata = {
  title: `Android App — Offline Accounting App for Pakistan`,
  description: `${brand.name} for Android: the full offline hisaab-kitab app. Sales, purchases, payments, stock and udhaar without internet, synced when you are back online.`,
  alternates: { canonical: "/download" },
};

export default function DownloadPage() {
  return <DownloadContent />;
}
