import type { MetadataRoute } from "next";

const base = "https://ledgerprosolution.com";

// FIXED lastmod — a sitemap must not churn lastModified on every build.
const lastModified = new Date("2026-10-02");

export default function sitemap(): MetadataRoute.Sitemap {
  // NOTE: /login and /signup are intentionally noindex (see app/(auth) layouts)
  // and must NOT appear here — a sitemap must never list noindex URLs.
  const pages: { path: string; priority: number }[] = [
    { path: "", priority: 1 },
    { path: "/terms", priority: 0.4 },
    { path: "/privacy", priority: 0.4 },
    { path: "/support", priority: 0.5 },
    { path: "/changelog", priority: 0.5 },
  ];
  return pages.map((p) => ({
    url: `${base}${p.path}`,
    lastModified,
    changeFrequency: "weekly",
    priority: p.priority,
  }));
}
