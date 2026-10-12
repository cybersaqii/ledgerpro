import { DocList } from "@/components/doc-list";

export default function PurchaseBillsPage() {
  return <DocList mode="PURCHASE" lockedType="BILL" titleKey="nav.bills" />;
}
