"use client";

import { useState } from "react";
import { Package } from "lucide-react";

/** Fallback tile palette per business type — professional, muted, dense. */
const TILE: Record<string, string> = {
  WHOLESALE: "from-slate-600 to-slate-800",
  RETAIL: "from-emerald-600 to-emerald-800",
  DISTRIBUTION: "from-sky-600 to-sky-800",
  PHARMACY: "from-teal-600 to-teal-800",
  CLINIC: "from-cyan-600 to-cyan-800",
  RESTAURANT: "from-amber-600 to-amber-800",
  SERVICES: "from-indigo-600 to-indigo-800",
  MANUFACTURING: "from-orange-600 to-orange-800",
  OTHER: "from-stone-500 to-stone-700",
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
      className={`flex shrink-0 items-center justify-center rounded-lg bg-gradient-to-br ${grad} text-white ring-1 ring-black/10 ${className}`}
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
