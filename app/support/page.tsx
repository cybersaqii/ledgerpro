import type { Metadata } from "next";
import { brand } from "@/lib/brand";
import { getPlatformSettings } from "@/lib/billing-guards";
import { SUPPORT_DEFAULTS } from "@/lib/support";
import SupportContent from "./content";

export const metadata: Metadata = {
  title: "Support",
  description: `Get help with ${brand.name} — contact details and a support request form.`,
};

// Contact details come from the database so the platform admin can change
// them without a deploy; never prerender at build time.
export const dynamic = "force-dynamic";

function setting(all: Record<string, string>, key: string): string {
  return all[key] || SUPPORT_DEFAULTS[key] || "";
}

export default async function SupportPage() {
  let all: Record<string, string> = {};
  try {
    all = await getPlatformSettings();
  } catch {
    all = {};
  }
  const email = setting(all, "support.email");
  const phone = setting(all, "support.phone");
  const hours = setting(all, "support.hours");
  return <SupportContent email={email} phone={phone} hours={hours} />;
}
