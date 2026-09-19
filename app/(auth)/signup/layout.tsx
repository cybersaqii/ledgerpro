import type { Metadata } from "next";
import { brand } from "@/lib/brand";

export const metadata: Metadata = {
  title: "Sign up free",
  description: `Create your free ${brand.name} account — sales, stock, payments and profit for every business. No credit card needed.`,
  robots: { index: false, follow: true },
};

export default function SignupLayout({ children }: { children: React.ReactNode }) {
  return children;
}
