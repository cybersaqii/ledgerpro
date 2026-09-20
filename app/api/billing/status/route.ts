import { requireCompany } from "@/lib/route-helpers";
import { json, err } from "@/lib/api";
import { billingStatusFor, getPlatformSettings, isPlatformAdminEmail } from "@/lib/billing-guards";

// GET /api/billing/status — current plan, trial countdown, payment instructions & prices.
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const billing = await billingStatusFor(gate.companyId);
  if (!billing) return err("Company not found.", 404);
  const settings = await getPlatformSettings();
  return json({
    data: {
      ...billing,
      isOwner: gate.session.role === "OWNER",
      isPlatformAdmin: isPlatformAdminEmail(gate.session.email || ""),
      prices: {
        monthlyPaisa: parseInt(settings["billing.monthly_price_paisa"] || "150000", 10),
        yearlyPaisa: parseInt(settings["billing.yearly_price_paisa"] || "1500000", 10),
      },
      paymentDetails: {
        bank: settings["billing.bank_details"] || "",
        jazzcash: settings["billing.jazzcash"] || "",
        easypaisa: settings["billing.easypaisa"] || "",
        instructions: settings["billing.instructions"] || "",
      },
    },
  });
}
