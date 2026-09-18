import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { bankAccounts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requireCompany, db } from "@/lib/route-helpers";
import { addBankAccount } from "@/lib/setup";
import { parseMoney } from "@/lib/money";
import { z } from "zod";

// GET /api/banks
export async function GET() {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.isActive, true)));
  return json({ data: rows });
}

const bankSchema = z.object({
  name: z.string().trim().min(2).max(80),
  kind: z.enum(["BANK", "CASH", "WALLET"]),
  bankName: z.string().trim().max(80).optional().or(z.literal("")),
  accountNo: z.string().trim().max(40).optional().or(z.literal("")),
  openingBalance: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/).default("0"),
});

// POST /api/banks
export async function POST(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = bankSchema.safeParse(body);
  if (!parsed.success) return err("Please check the form and try again.", 422);
  const b = parsed.data;

  const dup = await db
    .select({ id: bankAccounts.id })
    .from(bankAccounts)
    .where(and(eq(bankAccounts.companyId, companyId), eq(bankAccounts.name, b.name)))
    .limit(1);
  if (dup[0]) return err("An account with this name already exists.", 409);

  const opening = parseMoney(b.openingBalance);
  if (opening < 0n) return err("Opening balance cannot be negative.", 422);

  const ba = await addBankAccount(db, companyId, {
    name: b.name,
    kind: b.kind,
    bankName: b.bankName || undefined,
    accountNo: b.accountNo || undefined,
    openingBalance: opening,
  });
  return json({ data: ba }, { status: 201 });
}
