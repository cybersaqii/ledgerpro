import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import ChangelogContent from "./content";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What shipped recently in ${brand.name} — new features and improvements. Every release is listed with a short summary, so you always know what changed and when.`,
  alternates: { canonical: "/changelog" },
};

export default function ChangelogPage() {
  return <ChangelogContent />;
}
