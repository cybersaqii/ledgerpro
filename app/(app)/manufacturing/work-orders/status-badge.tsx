"use client";

// Work-order status pill, shared by the work-orders list and detail pages.
// Lives in its own module (not exported from page.tsx) so Next.js route
// type validation stays green — page files may only export page config.

const STATUS_COLORS: Record<string, string> = {
  DRAFT: "bg-muted text-muted-foreground",
  RELEASED: "bg-primary-soft text-primary",
  IN_PROGRESS: "bg-warning-soft text-warning",
  COMPLETED: "bg-success-soft text-success",
  CANCELLED: "bg-muted text-muted-foreground",
  VOIDED: "bg-danger-soft text-danger",
};

export function StatusBadge({ status, t }: { status: string; t: (k: string) => string }) {
  return (
    <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${STATUS_COLORS[status] ?? STATUS_COLORS.DRAFT}`}>
      {t(`mfg.st${status.charAt(0)}${status.slice(1).toLowerCase().replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())}`)}
    </span>
  );
}
