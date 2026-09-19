import type { MetadataRoute } from "next";

const base = "https://ledgerpro-pw5c.vercel.app";

export default function sitemap(): MetadataRoute.Sitemap {
  const pages: { path: string; priority: number }[] = [
    { path: "", priority: 1 },
    { path: "/signup", priority: 0.8 },
    { path: "/login", priority: 0.5 },
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
