import { brand } from "@/lib/brand";
import { en } from "@/lib/i18n/en";

const SITE = "https://www.ledgerprosolution.com";

function fillBrand(s: string): string {
  return s.replaceAll("{brand}", brand.name);
}

/**
 * SEO structured data (Organization + SoftwareApplication + FAQPage).
 * Server component rendered by app/page.tsx — never inside the "use client"
 * landing-content. FAQ questions/answers come VERBATIM from the landing
 * dictionary (en.landing.q0..q4 / a0..a4).
 */
export default function StructuredData() {
  const organization = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: brand.name,
    url: SITE,
    logo: `${SITE}/apple-icon`,
    description: brand.description,
  };
  const softwareApplication = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: brand.name,
    url: SITE,
    applicationCategory: "BusinessApplication",
    // Web app + the offline Android app (direct-install APK).
    operatingSystem: ["Web", "Android"],
    // Prices match the live pricing section (Nov 2026). Never invent
    // ratings or review counts here — aggregateRating stays out until
    // real user reviews exist.
    offers: [
      { "@type": "Offer", name: "Free", price: "0", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Starter Monthly", price: "1500", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Starter Yearly", price: "15000", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Professional Monthly", price: "2000", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Professional Yearly", price: "20000", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Enterprise Monthly", price: "3500", priceCurrency: "PKR" },
      { "@type": "Offer", name: "Enterprise Yearly", price: "35000", priceCurrency: "PKR" },
    ],
  };
  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: [0, 1, 2, 3, 4, 5].map((i) => ({
      "@type": "Question",
      name: fillBrand((en.landing as Record<string, string>)[`q${i}`]),
      acceptedAnswer: {
        "@type": "Answer",
        text: fillBrand((en.landing as Record<string, string>)[`a${i}`]),
      },
    })),
  };
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(organization) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareApplication) }} />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(faqPage) }} />
    </>
  );
}
