"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DocForm } from "@/components/doc-form";

function NewPurchaseInner() {
  const sp = useSearchParams();
  return <DocForm mode="PURCHASE" initialType={sp.get("type") || undefined} />;
}

export default function NewPurchasePage() {
  return <Suspense><NewPurchaseInner /></Suspense>;
}
