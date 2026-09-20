"use client";

import Link from "next/link";
import { FileQuestion, Home, LayoutDashboard, ScanBarcode } from "lucide-react";
import { brand } from "@/lib/brand";
import { useLang } from "@/components/lang-provider";

export default function NotFound() {
  const { t } = useLang();
  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="rise w-full max-w-md text-center">
        <span className="mx-auto grid h-20 w-20 place-items-center rounded-[1.75rem] bg-primary-soft text-primary">
          <FileQuestion size={38} />
        </span>
        <h1 className="mt-6 text-3xl font-extrabold tracking-tight">{t("notfound.title")}</h1>
        <p className="mt-2 leading-relaxed text-muted-foreground">{t("notfound.sub")}</p>
        <div className="mt-8 grid gap-2">
          <Link href="/dashboard" className="btn btn-primary w-full !py-3">
            <LayoutDashboard size={17} /> {t("notfound.dashboard")}
          </Link>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/sales/pos" className="btn btn-ghost w-full !py-3 text-sm">
              <ScanBarcode size={16} /> {t("notfound.pos")}
            </Link>
            <Link href="/" className="btn btn-ghost w-full !py-3 text-sm">
              <Home size={16} /> {t("notfound.home")}
            </Link>
          </div>
        </div>
        <p className="mt-8 text-xs text-muted-foreground">{brand.name} · {brand.tagline}</p>
      </div>
    </div>
  );
}
