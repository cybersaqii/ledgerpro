"use client";

import { use } from "react";
import { DocDetail } from "@/components/doc-detail";

export default function DebitNoteDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <DocDetail mode="NOTE" id={id} />;
}
