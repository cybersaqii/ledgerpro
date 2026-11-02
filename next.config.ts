import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async redirects() {
    return [
      // Landing anchors live on / — this vanity URL 404'd, redirect it.
      { source: "/features", destination: "/#features", permanent: true },
      // Dead-end section URLs — redirect to their real pages.
      { source: "/inventory", destination: "/inventory/products", permanent: true },
      { source: "/banking", destination: "/bank", permanent: true },
      { source: "/team", destination: "/settings", permanent: true },
      // QA sweep 2026-10-25: unlinked vanity URLs that 404'd. No blog or
      // docs section exists — send readers to the homepage / support page.
      { source: "/blog", destination: "/", permanent: true },
      { source: "/docs", destination: "/support", permanent: true },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
          {
            key: "Content-Security-Policy",
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' data: blob:",
              "font-src 'self' data:",
              "connect-src 'self'",
              "frame-ancestors 'none'",
              "base-uri 'self'",
              "form-action 'self'",
            ].join("; "),
          },
        ],
      },
    ];
  },
};

export default nextConfig;
