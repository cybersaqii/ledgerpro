import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { db } from "@/lib/db";
import { companies } from "@/db/schema";
import { eq } from "drizzle-orm";
import { AppShell } from "@/components/app-shell";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) redirect("/login");
  // Seed the shell's business type server-side so the first paint already uses
  // the company's vocabulary instead of flashing the wholesale default.
  // The client re-fetches /api/auth/me on navigation anyway (kept as-is).
  let businessType: string | null = null;
  try {
    const rows = await db
      .select({ businessType: companies.businessType })
      .from(companies)
      .where(eq(companies.id, session.cid))
      .limit(1);
    businessType = rows[0]?.businessType ?? null;
  } catch {
    /* company row unreadable — the client fetch remains the fallback */
  }
  return <AppShell initialBusinessType={businessType}>{children}</AppShell>;
}
