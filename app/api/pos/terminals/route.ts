import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { posTerminals, bankAccounts } from "@/db/schema";
import { posTerminalSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, defaultBranchId, assertBranch } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { logAudit } from "@/lib/audit";

function serialize(t: typeof posTerminals.$inferSelect) {
  return {
    id: t.id,
    branchId: t.branchId,
    name: t.name,
    cashAccountId: t.cashAccountId,
    receiptHeader: t.receiptHeader,
    receiptFooter: t.receiptFooter,
    receiptCopies: t.receiptCopies,
    autoPrint: t.autoPrint,
    isActive: t.isActive,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// GET /api/pos/terminals — list counter terminals (?active=1 to hide deactivated).
export async function GET(req: NextRequest) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const activeOnly = new URL(req.url).searchParams.get("active") === "1";
  const rows = await db
    .select()
    .from(posTerminals)
    .where(
      activeOnly
        ? and(eq(posTerminals.companyId, companyId), eq(posTerminals.isActive, true))
        : eq(posTerminals.companyId, companyId)
    )
    .orderBy(desc(posTerminals.updatedAt));
  return json({ data: rows.map(serialize) });
}

// POST /api/pos/terminals — register a counter terminal (drawer + print settings).
export async function POST(req: NextRequest) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const body = await req.json().catch(() => null);
  const parsed = posTerminalSchema.safeParse(body);
  if (!parsed.success) return err("Please check the terminal details and try again.", 422);
  const b = parsed.data;

  try {
    const terminal = await db.transaction(async (tx) => {
      const branchId = b.branchId || (await defaultBranchId(tx, companyId));
      await assertBranch(tx, companyId, branchId);
      // The drawer must be a cash/wallet bank account of this company.
      const ba = await tx
        .select({ id: bankAccounts.id, kind: bankAccounts.kind, isActive: bankAccounts.isActive })
        .from(bankAccounts)
        .where(and(eq(bankAccounts.id, b.cashAccountId), eq(bankAccounts.companyId, companyId)))
        .limit(1);
      if (!ba[0] || !ba[0].isActive)
        throw new Error("DRAWER_ACCOUNT_INVALID");
      if (ba[0].kind === "BANK")
        throw new Error("DRAWER_ACCOUNT_NOT_CASH");
      const nameTaken = await tx
        .select({ id: posTerminals.id })
        .from(posTerminals)
        .where(
          and(
            eq(posTerminals.companyId, companyId),
            eq(posTerminals.branchId, branchId),
            eq(posTerminals.name, b.name)
          )
        )
        .limit(1);
      if (nameTaken[0]) throw new Error("TERMINAL_NAME_TAKEN");
      const id = crypto.randomUUID();
      await tx.insert(posTerminals).values({
        id,
        companyId,
        branchId,
        name: b.name,
        cashAccountId: b.cashAccountId,
        receiptHeader: b.receiptHeader || null,
        receiptFooter: b.receiptFooter || null,
        receiptCopies: b.receiptCopies,
        autoPrint: b.autoPrint,
        createdById: session.uid,
      });
      const rows = await tx.select().from(posTerminals).where(eq(posTerminals.id, id)).limit(1);
      return rows[0];
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pos.terminal_created", entity: "pos_terminal", entityId: terminal.id,
      detail: `Terminal "${terminal.name}" registered`,
    });
    return json({ data: serialize(terminal) }, { status: 201 });
  } catch (e) {
    if (e instanceof Error && e.message === "TERMINAL_NAME_TAKEN")
      return err("A terminal with this name already exists in this branch.", 409, "TERMINAL_NAME_TAKEN");
    if (e instanceof Error && e.message === "DRAWER_ACCOUNT_INVALID")
      return err("Select a valid cash drawer account.", 422);
    if (e instanceof Error && e.message === "DRAWER_ACCOUNT_NOT_CASH")
      return err("The drawer must be a cash or wallet account, not a bank account.", 422);
    return toApiError(e, { route: "/api/pos/terminals", companyId });
  }
}
