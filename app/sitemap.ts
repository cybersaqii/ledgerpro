import type { MetadataRoute } from "next";

const base = "https://ledgerpro-pw5c.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  // NOTE: /login and /signup are intentionally noindex (see app/(auth) layouts)
  // and must NOT appear here — a sitemap must never list noindex URLs.
  const pages: { path: string; priority: number }[] = [
    { path: "", priority: 1 },
    { path: "/terms", priority: 0.4 },
    { path: "/privacy", priority: 0.4 },
  ];
  return pages.map((p) => ({
    url: `${base}${p.path}`,
    lastModified: new Date(),
    changeFrequency: "weekly",
    priority: p.priority,
  }));
}
