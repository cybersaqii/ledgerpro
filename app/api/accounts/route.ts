import { NextRequest } from "next/server";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { accounts, journalEntries, journalLines } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError, UserError } from "@/lib/errors";
import { requireCompany, requirePermission, db, parseDateOnly } from "@/lib/route-helpers";
import { assertPeriodOpen } from "@/lib/period";
import { parseMoney } from "@/lib/money";
import { sysAccount, SYS } from "@/lib/setup";
import { validateAccountCode } from "@/lib/chart-of-accounts";
import { logAudit } from "@/lib/audit";

const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "INCOME", "EXPENSE"] as const;

// GET /api/accounts?type=EXPENSE — chart of accounts (for expense forms etc.)
// ?tree=1 nests children under their parents for the chart-of-accounts page.
export async function GET(req: NextRequest) {
  const gate = await requireCompany();
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const type = req.nextUrl.searchParams.get("type");
  const tree = req.nextUrl.searchParams.get("tree") === "1";
  const conds = [eq(accounts.companyId, companyId), eq(accounts.isActive, true)];
  if (type) conds.push(eq(accounts.type, type));
  const rows = await db.select().from(accounts).where(and(...conds));
  if (!tree) return json({ data: rows });

  const { buildAccountTree } = await import("@/lib/chart-of-accounts");
  const treeRows = buildAccountTree(
    rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      type: r.type,
      parentId: r.parentId,
      isSystem: r.isSystem,
      isActive: r.isActive,
      openingBalance: BigInt(r.openingBalance),
    }))
  );
  return json({ data: treeRows });
}

const createSchema = z.object({
  code: z.string().trim().min(1).max(10),
  name: z.string().trim().min(1).max(120),
  type: z.enum(ACCOUNT_TYPES),
  parentId: z.string().min(1).nullable().optional(),
  openingBalance: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/, "Invalid opening balance").optional(),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date").optional(),
});

// POST /api/accounts — create a GL account (COA management; settings perm)
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { companyId, session } = gate;
  const body = await req.json().catch(() => ({}));
  const b = createSchema.safeParse(body);
  if (!b.success) return err(b.error.issues[0]?.message ?? "Invalid account.", 422);

  try {
    validateAccountCode(b.data.code, b.data.type);
  } catch (e) {
    return toApiError(e, { route: "/api/accounts", companyId });
  }

  try {
    const result = await db.transaction(async (tx) => {
      const code = b.data.code.trim();
      const dup = await tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.companyId, companyId), eq(accounts.code, code)))
        .limit(1);
      if (dup[0]) throw new UserError(`Code ${code} is already used.`, 409, "ACCOUNT_CODE_DUP");

      let parentId: string | null = null;
      if (b.data.parentId) {
        const pr = await tx
          .select()
          .from(accounts)
          .where(and(eq(accounts.id, b.data.parentId), eq(accounts.companyId, companyId)))
          .limit(1);
        if (!pr[0]) throw new UserError("Parent account not found.", 404, "ACCOUNT_NOT_FOUND");
        if (pr[0].type !== b.data.type)
          throw new UserError("A child account must be the same type as its parent.", 422, "ACCOUNT_PARENT_TYPE");
        parentId = pr[0].id;
      }

      const opening = b.data.openingBalance ? parseMoney(b.data.openingBalance) : 0n;
      const openingDate = b.data.openingDate ? parseDateOnly(b.data.openingDate) : null;
      if (opening !== 0n && !openingDate)
        throw new UserError("An opening balance needs an opening date.", 422, "VALIDATION_ERROR");
      if (openingDate) await assertPeriodOpen(tx, companyId, openingDate);

      const id = crypto.randomUUID();
      const abs = opening < 0n ? -opening : opening;
      await tx.insert(accounts).values({
        id,
        companyId,
        code,
        name: b.data.name.trim(),
        type: b.data.type,
        parentId,
        isSystem: false,
        isActive: true,
        openingBalance: abs,
      });

      if (opening !== 0n && openingDate) {
        // Opening-balance journal — the account's ledger starts exactly here,
        // mirroring the party opening-balance flow (lib/party-create.ts).
        const equityId = await sysAccount(tx, companyId, SYS.OPENING_EQUITY);
        const debitNormal = b.data.type === "ASSET" || b.data.type === "EXPENSE";
        const debitAccount = debitNormal ? opening > 0n : opening < 0n;
        const entryId = crypto.randomUUID();
        await tx.insert(journalEntries).values({
          id: entryId,
          companyId,
          date: openingDate,
          memo: `Opening balance — ${b.data.name.trim()} (${code})`,
          source: "OPENING",
          createdById: session.uid,
        });
        await tx.insert(journalLines).values([
          { id: crypto.randomUUID(), entryId, accountId: debitAccount ? id : equityId, debit: abs, credit: 0n },
          { id: crypto.randomUUID(), entryId, accountId: debitAccount ? equityId : id, debit: 0n, credit: abs },
        ]);
      }
      return { id };
    });

    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "account.created", entity: "account", entityId: result.id,
      detail: `${b.data.code.trim()} ${b.data.name.trim()}`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/accounts", companyId });
  }
}
