"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { DocForm } from "@/components/doc-form";

function NewSaleInner() {
  const sp = useSearchParams();
  return <DocForm mode="SALES" initialType={sp.get("type") || undefined} editDocId={sp.get("edit") || undefined} />;
}

export default function NewSalePage() {
  return <Suspense><NewSaleInner /></Suspense>;
}
