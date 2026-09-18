import { SalesDetailPage } from "@/components/doc-detail";

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  return <SalesDetailPage params={params} />;
}
