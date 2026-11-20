import type { MetadataRoute } from "next";

const base = "https://www.ledgerprosolution.com";

// FIXED lastmod — a sitemap must not churn lastModified on every build.
// Bumped when public pages actually change (pricing + download pages
// added Nov 2026; Phase 3 guides added 2026-11-20).
const lastModified = new Date("2026-11-20");

export default function sitemap(): MetadataRoute.Sitemap {
  // NOTE: /login and /signup are intentionally noindex (see app/(auth) layouts)
  // and must NOT appear here — a sitemap must never list noindex URLs.
  const pages: { path: string; priority: number }[] = [
    { path: "", priority: 1 },
    { path: "/pricing", priority: 0.8 },
    { path: "/download", priority: 0.6 },
    { path: "/terms", priority: 0.4 },
    { path: "/privacy", priority: 0.4 },
    { path: "/support", priority: 0.5 },
    { path: "/changelog", priority: 0.5 },
    // Phase 3: honest SEO content pages (no ranking claims anywhere).
    { path: "/guides/wholesale-hisaab-software", priority: 0.6 },
    { path: "/guides/offline-hisaab-app", priority: 0.6 },
    { path: "/guides/hisaab-software-price-pakistan", priority: 0.6 },
  ];
  return pages.map((p) => ({
    url: `${base}${p.path}`,
    lastModified,
    changeFrequency: "weekly",
    priority: p.priority,
  }));
}
