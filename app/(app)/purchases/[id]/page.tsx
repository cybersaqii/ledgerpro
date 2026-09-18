import { PurchaseDetailPage } from "@/components/doc-detail";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <PurchaseDetailPage params={params} />;
}
