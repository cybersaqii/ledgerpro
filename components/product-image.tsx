"use client";

import { useState } from "react";
import { Package } from "lucide-react";

/** Fallback tile palette per business type — token-derived gradients
 * (.tile-* aliases in globals.css), so dark mode and the Ink & Gold
 * identity apply automatically. */
const TILE: Record<string, string> = {
  WHOLESALE: "tile-neutral",
  RETAIL: "tile-success",
  DISTRIBUTION: "tile-primary",
  PHARMACY: "tile-primary",
  CLINIC: "tile-accent",
  RESTAURANT: "tile-accent",
  SERVICES: "tile-primary",
  MANUFACTURING: "tile-danger",
  OTHER: "tile-neutral",
};

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Product thumbnail: real image when a valid URL exists, otherwise a
 * professional gradient tile with the product's initials, tinted by the
 * company's business type. Broken images fall back gracefully.
 */
export function ProductImage({
  name,
  imageUrl,
  businessType,
  size = 40,
  className = "",
}: {
  name: string;
  imageUrl?: string | null;
  businessType?: string | null;
  size?: number;
  className?: string;
}) {
  const [broken, setBroken] = useState(false);
  const showImg = !!imageUrl && !broken;
  const grad = TILE[(businessType || "OTHER").toUpperCase()] ?? TILE.OTHER;
  const style = { width: size, height: size };
  if (showImg) {
    return (
      <img
        src={imageUrl as string}
        alt={name}
        width={size}
        height={size}
        loading="lazy"
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
        style={style}
        className={`shrink-0 rounded-lg object-cover ring-1 ring-black/10 ${className}`}
      />
    );
  }
  return (
    <span
      aria-hidden
      style={style}
      className={`tile ${grad} shrink-0 ring-1 ring-black/10 ${className}`}
    >
      {name && initials(name) !== "?" ? (
        <span className="font-extrabold tracking-tight" style={{ fontSize: size * 0.38 }}>
          {initials(name)}
        </span>
      ) : (
        <Package size={size * 0.45} strokeWidth={2.2} />
      )}
    </span>
  );
}
