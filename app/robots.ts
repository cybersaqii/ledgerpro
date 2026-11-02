import type { MetadataRoute } from "next";

const base = "https://www.ledgerprosolution.com";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        // App routes + auth pages must never be crawled. (Login/signup
        // are client components, so they cannot export noindex metadata —
        // robots disallow is the correct control for them.)
        disallow: [
          "/api/",
          "/login",
          "/signup",
          "/dashboard/",
          "/sales/",
          "/purchases/",
          "/parties/",
          "/products/",
          "/payments/",
          "/expenses/",
          "/stock/",
          "/reports/",
          "/settings/",
          "/billing/",
          "/bank/",
          "/inventory/",
          "/pos/",
          "/admin/",
          "/payroll/",
          "/assets/",
          "/projects/",
          "/manufacturing/",
          "/help/",
          "/partners/",
          "/notifications/",
          "/approvals/",
          "/analytical-reports/",
          "/portals/",
          "/tax/",
          "/welcome/",
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
