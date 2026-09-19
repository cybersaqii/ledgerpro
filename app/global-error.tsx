"use client";

// Root-level fallback. It renders without the app's layout or global styles,
// so everything is inline. Must include its own <html> and <body>.
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <html lang="en">
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
            <h1 style={{ margin: "20px 0 0", fontSize: 28 }}>LedgerPro ran into a problem</h1>
            <p style={{ color: "rgba(236,253,245,.7)", lineHeight: 1.6 }}>
              The application could not start. Your saved data is safe on the server.
              Please reload the page.
            </p>
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
              Reload
            </button>
          </div>
        </div>
      </body>
    </html>
  );
}
