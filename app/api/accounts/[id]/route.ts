import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { getCompanyAccount, countAccountUsage, wouldCycle, listCompanyAccounts } from "@/lib/chart-of-accounts";
import { logAudit } from "@/lib/audit";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  parentId: z.string().min(1).nullable().optional(),
  isActive: z.boolean().optional(),
});

// PATCH /api/accounts/[id] — rename, re-parent, activate/deactivate.
// System accounts are locked: name/parent/type/code can never change; only
// deactivation is allowed (and even that is blocked while lines reference them).
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const b = patchSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid update.", 422);

  try {
    const updated = await db.transaction(async (tx) => {
      const acc = await getCompanyAccount(tx, companyId, id);

      if (b.data.parentId !== undefined) {
        if (acc.isSystem) throw new UserError("System accounts cannot be re-parented.", 422, "ACCOUNT_SYSTEM_LOCKED");
        if (b.data.parentId) {
          const parent = await getCompanyAccount(tx, companyId, b.data.parentId);
          if (parent.type !== acc.type)
            throw new UserError("A child account must be the same type as its parent.", 422, "ACCOUNT_PARENT_TYPE");
          const all = await listCompanyAccounts(tx, companyId);
          if (wouldCycle(all, id, b.data.parentId))
            throw new UserError("This parent would create a cycle.", 422, "ACCOUNT_CYCLE");
        }
      }

      if (b.data.isActive === false) {
        const used = await countAccountUsage(tx, id);
        if (used > 0)
          throw new UserError(
            "This account has journal entries and cannot be deactivated. Create a replacement account instead.",
            422,
            "ACCOUNT_IN_USE"
          );
        const kids = await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(and(eq(accounts.companyId, companyId), eq(accounts.parentId, id), eq(accounts.isActive, true)))
          .limit(1);
        if (kids[0])
          throw new UserError("Deactivate its child accounts first.", 422, "ACCOUNT_HAS_CHILDREN");
      }

      const patch: Partial<{ name: string; parentId: string | null; isActive: boolean; updatedAt: Date }> = {
        updatedAt: new Date(),
      };
      if (b.data.name !== undefined) {
        if (acc.isSystem) throw new UserError("System accounts cannot be renamed.", 422, "ACCOUNT_SYSTEM_LOCKED");
        patch.name = b.data.name.trim();
      }
      if (b.data.parentId !== undefined) patch.parentId = b.data.parentId;
      if (b.data.isActive !== undefined) patch.isActive = b.data.isActive;

      await tx.update(accounts).set(patch).where(eq(accounts.id, id));
      return { id, code: acc.code };
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "account.updated", entity: "account", entityId: id,
      detail: `${updated.code} updated`,
    });
    return json({ data: updated });
  } catch (e) {
    return toApiError(e, { route: "/api/accounts/[id]", companyId });
  }
}

// DELETE /api/accounts/[id] — hard delete, only for unused non-system accounts
// with no children. Anything with history must be deactivated instead.
export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const { id } = await params;

  try {
    const deleted = await db.transaction(async (tx) => {
      const acc = await getCompanyAccount(tx, companyId, id);
      if (acc.isSystem) throw new UserError("System accounts cannot be deleted.", 422, "ACCOUNT_SYSTEM_LOCKED");
      const used = await countAccountUsage(tx, id);
      if (used > 0)
        throw new UserError("This account has journal entries — deactivate it instead of deleting.", 422, "ACCOUNT_IN_USE");
      const kids = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, companyId), eq(accounts.parentId, id)))
        .limit(1);
      if (kids[0]) throw new UserError("Delete its child accounts first.", 422, "ACCOUNT_HAS_CHILDREN");
      await tx.delete(accounts).where(eq(accounts.id, id));
      return { id, code: acc.code, name: acc.name };
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "account.deleted", entity: "account", entityId: id,
      detail: `${deleted.code} ${deleted.name}`,
    });
    return json({ data: { id } });
  } catch (e) {
    return toApiError(e, { route: "/api/accounts/[id]", companyId });
  }
}
