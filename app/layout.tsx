import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_Arabic } from "next/font/google";
import "./globals.css";
import { AppThemeProvider } from "@/components/theme-provider";
import { LangProvider } from "@/components/lang-provider";
import { brand } from "@/lib/brand";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });
// Clean Naskh-style Urdu font — simple letterforms, easy for beginners
// (Nastaliq is calligraphic and harder to read).
const urduSans = Noto_Sans_Arabic({ variable: "--font-urdu", subsets: ["arabic"], weight: ["400", "500", "600", "700"] });

const siteUrl = "https://ledgerpro-pw5c.vercel.app";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: `${brand.name} — ${brand.tagline}`,
    template: `%s · ${brand.name}`,
  },
  description: brand.description,
  keywords: ["accounting software", "hisaab kitab", "inventory", "POS", "invoicing", "Pakistan", "udhaar ledger", "stock management"],
  authors: [{ name: brand.name }],
  robots: { index: true, follow: true },
  openGraph: {
    type: "website",
    url: siteUrl,
    siteName: brand.name,
    title: `${brand.name} — ${brand.tagline}`,
    description: brand.description,
  },
  twitter: {
    card: "summary",
    title: `${brand.name} — ${brand.tagline}`,
    description: brand.description,
  },
};

export const viewport: Viewport = {
  themeColor: "#059669",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${geistSans.variable} ${geistMono.variable} ${urduSans.variable} h-full antialiased`}>
      <body className="min-h-full">
        <AppThemeProvider><LangProvider>{children}</LangProvider></AppThemeProvider>
      </body>
    </html>
  );
}
