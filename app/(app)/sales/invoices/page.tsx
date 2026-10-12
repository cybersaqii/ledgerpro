import { DocList } from "@/components/doc-list";

export default function SalesInvoicesPage() {
  return <DocList mode="SALES" lockedType="INVOICE" titleKey="nav.invoices" />;
}
