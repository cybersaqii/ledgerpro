import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import ChangelogContent from "./content";

export const metadata: Metadata = {
  title: "Changelog",
  description: `What shipped recently in ${brand.name} — new features and improvements.`,
};

export default function ChangelogPage() {
  return <ChangelogContent />;
}
