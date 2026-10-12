import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import PubHeader from "../pub-header";
import AboutContent from "./content";

export const metadata: Metadata = {
  title: "About",
  description: `${brand.name} is built by TechSol — a software company in Islamabad, Pakistan. Meet the company behind your hisaab.`,
  alternates: { canonical: "/about" },
};

export default function AboutPage() {
  return (
    <div className="min-h-screen bg-background">
      <PubHeader />
      <AboutContent />
    </div>
  );
}
