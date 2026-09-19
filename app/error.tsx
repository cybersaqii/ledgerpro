"use client";

import Link from "next/link";
import { TriangleAlert, RotateCcw, LayoutDashboard } from "lucide-react";

export default function Error({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="rise w-full max-w-md text-center">
        <span className="mx-auto grid h-20 w-20 place-items-center rounded-[1.75rem] bg-amber-500/15 text-amber-500">
          <TriangleAlert size={38} />
        </span>
        <h1 className="mt-6 text-3xl font-extrabold tracking-tight">Something went wrong</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">
          This page hit an unexpected error. Your saved data is not affected — try again or head back to the dashboard.
        </p>
        <div className="mt-8 grid gap-2">
          <button onClick={reset} className="btn btn-primary w-full !py-3">
            <RotateCcw size={17} /> Try again
          </button>
          <Link href="/dashboard" className="btn btn-ghost w-full !py-3 text-sm">
            <LayoutDashboard size={16} /> Go to dashboard
          </Link>
        </div>
      </div>
    </div>
  );
}
