import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import DownloadContent from "./content";

export const metadata: Metadata = {
  title: `Android app — ${brand.name}`,
  description: `${brand.name} for Android: the full offline app. Sales, purchases, payments, stock and reports without internet, synced when you are back online.`,
  alternates: { canonical: "/download" },
};

export default function DownloadPage() {
  return <DownloadContent />;
}
