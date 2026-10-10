"use client";

import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Deep link for a journal source row. Sales journals point at the invoice,
 * purchase journals at the bill, payment journals at the voucher — everywhere
 * else the reference stays plain text. Company scoping is enforced by the
 * destination page's own API, so a stale/wrong id can never leak data.
 */
export function sourceHref(source: string | null | undefined, sourceId: string | null | undefined): string | null {
  if (!source || !sourceId) return null;
  if (source === "SALES") return `/sales/${sourceId}`;
  if (source === "PURCHASE") return `/purchases/${sourceId}`;
  if (source === "PAYMENT") return `/payments/${sourceId}`;
  if (source === "TRANSFER") return `/payments/transfers`;
  return null;
}

/** Renders a link when the source resolves, plain text otherwise. */
export function DocRefLink({
  source,
  sourceId,
  label,
  className,
}: {
  source: string | null | undefined;
  sourceId: string | null | undefined;
  label: ReactNode;
  className?: string;
}) {
  const href = sourceHref(source, sourceId);
  if (!href) return <span className={className}>{label}</span>;
  return (
    <Link href={href} className={className ?? "font-bold text-primary hover:underline"}>
      {label}
    </Link>
  );
}
