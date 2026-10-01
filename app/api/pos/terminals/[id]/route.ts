import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { posTerminals, bankAccounts, posSessions } from "@/db/schema";
import { posTerminalUpdateSchema } from "@/lib/validators";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db, assertBranch } from "@/lib/route-helpers";
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

async function loadTerminal(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(posTerminals)
    .where(and(eq(posTerminals.id, id), eq(posTerminals.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

// PATCH /api/pos/terminals/[id] — update name, drawer account, print settings.
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = posTerminalUpdateSchema.safeParse(body);
  if (!parsed.success) return err("Please check the terminal details and try again.", 422);
  const b = parsed.data;

  try {
    const terminal = await db.transaction(async (tx) => {
      const t = await loadTerminal(companyId, id);
      if (!t) throw new Error("TERMINAL_NOT_FOUND");
      if (b.name && b.name !== t.name) {
        const taken = await tx
          .select({ id: posTerminals.id })
          .from(posTerminals)
          .where(
            and(
              eq(posTerminals.companyId, companyId),
              eq(posTerminals.branchId, t.branchId),
              eq(posTerminals.name, b.name)
            )
          )
          .limit(1);
        if (taken[0]) throw new Error("TERMINAL_NAME_TAKEN");
      }
      if (b.cashAccountId) {
        const ba = await tx
          .select({ id: bankAccounts.id, kind: bankAccounts.kind, isActive: bankAccounts.isActive })
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, b.cashAccountId), eq(bankAccounts.companyId, companyId)))
          .limit(1);
        if (!ba[0] || !ba[0].isActive) throw new Error("DRAWER_ACCOUNT_INVALID");
        if (ba[0].kind === "BANK") throw new Error("DRAWER_ACCOUNT_NOT_CASH");
        // A terminal mid-shift keeps its original drawer — the open session
        // denormalized its own copy, so changing it now only affects the next shift.
      }
      await assertBranch(tx, companyId, t.branchId);
      await tx
        .update(posTerminals)
        .set({
          ...(b.name ? { name: b.name } : {}),
          ...(b.cashAccountId ? { cashAccountId: b.cashAccountId } : {}),
          ...(b.receiptHeader !== undefined ? { receiptHeader: b.receiptHeader || null } : {}),
          ...(b.receiptFooter !== undefined ? { receiptFooter: b.receiptFooter || null } : {}),
          ...(b.receiptCopies !== undefined ? { receiptCopies: b.receiptCopies } : {}),
          ...(b.autoPrint !== undefined ? { autoPrint: b.autoPrint } : {}),
          ...(b.isActive !== undefined ? { isActive: b.isActive } : {}),
        })
        .where(eq(posTerminals.id, id));
      const rows = await tx.select().from(posTerminals).where(eq(posTerminals.id, id)).limit(1);
      return rows[0];
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pos.terminal_updated", entity: "pos_terminal", entityId: id,
      detail: `Terminal "${terminal.name}" updated`,
    });
    return json({ data: serialize(terminal) });
  } catch (e) {
    if (e instanceof Error && e.message === "TERMINAL_NOT_FOUND") return err("POS terminal not found.", 404);
    if (e instanceof Error && e.message === "TERMINAL_NAME_TAKEN")
      return err("A terminal with this name already exists in this branch.", 409, "TERMINAL_NAME_TAKEN");
    if (e instanceof Error && e.message === "DRAWER_ACCOUNT_INVALID")
      return err("Select a valid cash drawer account.", 422);
    if (e instanceof Error && e.message === "DRAWER_ACCOUNT_NOT_CASH")
      return err("The drawer must be a cash or wallet account, not a bank account.", 422);
    return toApiError(e, { route: "/api/pos/terminals/[id]", companyId });
  }
}

// DELETE /api/pos/terminals/[id] — deactivate (kept for shift history).
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("pos");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const pro = await requirePro("pos");
  if (!pro.ok) return pro.response;
  const { id } = await params;
  try {
    await db.transaction(async (tx) => {
      const t = await loadTerminal(companyId, id);
      if (!t) throw new Error("TERMINAL_NOT_FOUND");
      const open = await tx
        .select({ id: posSessions.id })
        .from(posSessions)
        .where(
          and(
            eq(posSessions.companyId, companyId),
            eq(posSessions.terminalId, id),
            eq(posSessions.status, "OPEN")
          )
        )
        .limit(1);
      if (open[0]) throw new Error("TERMINAL_HAS_OPEN_SESSION");
      await tx.update(posTerminals).set({ isActive: false }).where(eq(posTerminals.id, id));
    });
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "pos.terminal_deactivated", entity: "pos_terminal", entityId: id,
      detail: "Terminal deactivated",
    });
    return json({ data: { id, isActive: false } });
  } catch (e) {
    if (e instanceof Error && e.message === "TERMINAL_NOT_FOUND") return err("POS terminal not found.", 404);
    if (e instanceof Error && e.message === "TERMINAL_HAS_OPEN_SESSION")
      return err("Close the open shift on this terminal before deactivating it.", 409, "TERMINAL_HAS_OPEN_SESSION");
    return toApiError(e, { route: "/api/pos/terminals/[id]", companyId });
  }
}
