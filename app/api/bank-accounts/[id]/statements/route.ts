import { NextRequest } from "next/server";
import { eq, and, desc } from "drizzle-orm";
import { z } from "zod";
import { bankAccounts, bankStatements } from "@/db/schema";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { importBankStatement, mapStatementRows, parseCsvRows, type ColumnMapping } from "@/lib/statements";
import { parseMoney } from "@/lib/money";

type Ctx = { params: Promise<{ id: string }> };

async function bankOf(companyId: string, id: string) {
  const rows = await db
    .select()
    .from(bankAccounts)
    .where(and(eq(bankAccounts.id, id), eq(bankAccounts.companyId, companyId)))
    .limit(1);
  return rows[0] ?? null;
}

const mappingSchema = z.object({
  date: z.number().int().min(0).max(60),
  description: z.number().int().min(0).max(60),
  reference: z.number().int().min(0).max(60).nullable().optional(),
  debit: z.number().int().min(0).max(60).nullable().optional(),
  credit: z.number().int().min(0).max(60).nullable().optional(),
  amount: z.number().int().min(0).max(60).nullable().optional(),
});

const importSchema = z.object({
  // "preview" = two-pass validation + duplicate flags without writing;
  // "import" = full validated import.
  mode: z.enum(["preview", "import"]).default("import"),
  fileName: z.string().trim().min(1).max(200),
  csvText: z.string().min(1).max(2_000_000),
  mapping: mappingSchema,
  skipHeader: z.boolean().default(true),
  openingBalance: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/).optional(),
  closingBalance: z.string().regex(/^-?\d{1,12}(\.\d{1,2})?$/).optional(),
});

// GET /api/bank-accounts/[id]/statements — list import sessions for one account
export async function GET(_req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const { id } = await ctx.params;
  const bank = await bankOf(companyId, id);
  if (!bank) return err("Bank account not found.", 404);

  const rows = await db
    .select()
    .from(bankStatements)
    .where(and(eq(bankStatements.companyId, companyId), eq(bankStatements.bankAccountId, id)))
    .orderBy(desc(bankStatements.createdAt));
  return json({
    data: rows.map((r) => ({
      ...r,
      openingBalance: r.openingBalance.toString(),
      closingBalance: r.closingBalance == null ? null : r.closingBalance.toString(),
      createdAt: (r.createdAt as unknown as Date).getTime(),
    })),
  });
}

// POST /api/bank-accounts/[id]/statements — preview or import a CSV bank statement
export async function POST(req: NextRequest, ctx: Ctx) {
  const gate = await requirePermission("payments");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const { id } = await ctx.params;
  const bank = await bankOf(companyId, id);
  if (!bank) return err("Bank account not found.", 404);

  const body = await req.json().catch(() => null);
  const parsed = importSchema.safeParse(body);
  if (!parsed.success) return err("Please check the import settings and try again.", 422, "VALIDATION_ERROR");
  const b = parsed.data;
  const mapping: ColumnMapping = {
    date: b.mapping.date,
    description: b.mapping.description,
    reference: b.mapping.reference ?? null,
    debit: b.mapping.debit ?? null,
    credit: b.mapping.credit ?? null,
    amount: b.mapping.amount ?? null,
  };

  try {
    if (b.mode === "preview") {
      // Pass 1: parse + validate + within-file duplicate flags, no writes.
      const rows = parseCsvRows(b.csvText);
      const { lines, errors } = mapStatementRows(rows, mapping, { skipHeader: b.skipHeader });
      if (errors.length > 0)
        return err(`Import failed with ${errors.length} error(s):\n${errors.slice(0, 12).join("\n")}`, 422);
      const seen = new Set<string>();
      const preview = lines.map((l) => {
        const key = `${l.date.getTime()}|${l.amount.toString()}|${(l.reference ?? "").toLowerCase()}`;
        const dup = seen.has(key);
        seen.add(key);
        return {
          rowNo: l.rowNo,
          date: l.date.getTime(),
          description: l.description,
          reference: l.reference,
          debit: l.debit.toString(),
          credit: l.credit.toString(),
          amount: l.amount.toString(),
          isDuplicate: dup,
        };
      });
      return json({ data: { lines: preview, lineCount: lines.length } });
    }

    const result = await db.transaction((tx) =>
      importBankStatement(tx, {
        companyId,
        bankAccountId: bank.id,
        fileName: b.fileName,
        csvText: b.csvText,
        mapping,
        skipHeader: b.skipHeader,
        openingBalance: b.openingBalance ? parseMoney(b.openingBalance) : undefined,
        closingBalance: b.closingBalance ? parseMoney(b.closingBalance) : undefined,
        createdById: session.uid,
      })
    );
    await logAudit(db, {
      companyId, userId: session.uid, userName: session.name,
      action: "bank.statement_imported", entity: "bank_statement", entityId: result.statementId,
      detail: `Statement "${b.fileName}" imported on "${bank.name}" — ${result.lineCount} lines (${result.duplicateCount} duplicates)`,
    });
    return json({ data: result }, { status: 201 });
  } catch (e) {
    return toApiError(e, { route: "/api/bank-accounts/[id]/statements", companyId });
  }
}
