import type { MetadataRoute } from "next";

const base = "https://ledgerpro-pw5c.vercel.app";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        allow: ["/"],
        disallow: [
          "/api/",
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
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  };
}
