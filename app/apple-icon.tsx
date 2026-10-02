import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

/**
 * Apple touch icon (180×180), generated with Satori — pure JSX, no assets.
 * Navy rounded square with the gold LedgerProSolution "L" mark.
 */
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: 180,
          height: 180,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#101a2c",
          borderRadius: 40,
        }}
      >
        <div
          style={{
            width: 108,
            height: 108,
            borderRadius: 26,
            backgroundColor: "#f0b73f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 62,
            fontWeight: 800,
            color: "#101a2c",
          }}
        >
          L
        </div>
      </div>
    ),
    { ...size },
  );
}
