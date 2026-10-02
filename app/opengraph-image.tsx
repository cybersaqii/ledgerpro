import { ImageResponse } from "next/og";
import { brand } from "@/lib/brand";

export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

/**
 * Social share card (1200×630), generated at request time with Satori —
 * pure JSX, no external assets. Deep navy + gold on-brand styling.
 */
export default function OgImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 1200,
          height: 630,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "0 96px",
          backgroundColor: "#101a2c",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* gold accent bar */}
        <div
          style={{
            position: "absolute",
            left: 96,
            top: 118,
            width: 72,
            height: 8,
            borderRadius: 4,
            backgroundColor: "#f0b73f",
          }}
        />
        <div style={{ display: "flex", alignItems: "center", marginTop: 40 }}>
          {/* logo mark */}
          <div
            style={{
              width: 92,
              height: 92,
              borderRadius: 24,
              backgroundColor: "#f0b73f",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 52,
              fontWeight: 800,
              color: "#101a2c",
            }}
          >
            L
          </div>
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 28 }}>
            <div style={{ fontSize: 68, fontWeight: 800, color: "#ffffff", letterSpacing: -1 }}>
              {brand.name}
            </div>
            <div style={{ fontSize: 30, color: "rgba(255,255,255,0.72)", marginTop: 6 }}>
              {brand.tagline}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", marginTop: 48, gap: 16 }}>
          {["Sales", "Stock", "Udhaar", "Profit reports"].map((f) => (
            <div
              key={f}
              style={{
                fontSize: 26,
                fontWeight: 700,
                color: "#f0b73f",
                border: "2px solid rgba(240,183,63,0.5)",
                borderRadius: 999,
                padding: "10px 28px",
              }}
            >
              {f}
            </div>
          ))}
        </div>
        <div style={{ fontSize: 26, color: "rgba(255,255,255,0.55)", marginTop: 40 }}>
          Free to start · No credit card needed · ledgerprosolution.com
        </div>
      </div>
    ),
    { ...size },
  );
}
