"use client";

import { useState } from "react";

// Root-level fallback. It renders without the app's layout or global styles
// (and without the i18n provider), so everything is inline. Copy below mirrors
// the `globalerror.*` dictionary keys; the language comes from localStorage
// ("lp-lang") since the provider is unavailable here.
const COPY: Record<"en" | "ur", { title: string; body: string; reload: string }> = {
  en: {
    title: "LedgerProSolution ran into a problem",
    body: "The application could not start. Your saved data is safe on the server. Please reload the page.",
    reload: "Reload",
  },
  ur: {
    title: "LedgerProSolution میں مسئلہ پیش آیا",
    body: "ایپلیکیشن شروع نہیں ہو سکی۔ آپ کا محفوظ ڈیٹا سرور پر موجود ہے۔ براہ کرم صفحہ دوبارہ لوڈ کریں۔",
    reload: "دوبارہ لوڈ کریں",
  },
};

export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // The i18n provider is unavailable here, so the language comes from
  // localStorage at first render (SSR-safe: English on the server).
  const [lang] = useState<"en" | "ur">(() => {
    try {
      return typeof window !== "undefined" && window.localStorage.getItem("lp-lang") === "ur" ? "ur" : "en";
    } catch {
      return "en";
    }
  });
  const c = COPY[lang];
  return (
    <html lang={lang} dir={lang === "ur" ? "rtl" : "ltr"}>
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#0a2e25", color: "#ecfdf5" }}>
        <div
          style={{
            minHeight: "100vh",
            display: "grid",
            placeItems: "center",
            padding: 24,
            textAlign: "center",
          }}
        >
          <div style={{ maxWidth: 420 }}>
            <div
              style={{
                width: 72,
                height: 72,
                margin: "0 auto",
                borderRadius: 20,
                background: "rgba(245,158,11,.18)",
                color: "#f59e0b",
                display: "grid",
                placeItems: "center",
                fontSize: 36,
                fontWeight: 800,
              }}
            >
              !
            </div>
            <h1 style={{ margin: "20px 0 0", fontSize: 28 }}>{c.title}</h1>
            <p style={{ color: "rgba(236,253,245,.7)", lineHeight: 1.6 }}>{c.body}</p>
            <button
              onClick={reset}
              style={{
                marginTop: 16,
                padding: "12px 28px",
                borderRadius: 12,
                border: 0,
                background: "#10b981",
                color: "#fff",
                fontSize: 16,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {c.reload}
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
