import { DocList } from "@/components/doc-list";

export default function PurchaseOrdersPage() {
  return <DocList mode="PURCHASE" lockedType="ORDER" titleKey="nav.po" />;
}
