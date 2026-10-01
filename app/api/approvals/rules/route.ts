import { NextRequest } from "next/server";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { approvalRules } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { logAudit } from "@/lib/audit";
import { clientIp } from "@/lib/rate-limit-db";
import {
  APPROVAL_DOC_TYPES,
  isApprovalDocType,
  getApprovalRules,
  type ApprovalDocType,
} from "@/lib/approvals";
import { parseMoney } from "@/lib/money";

const ruleSchema = z.object({
  docType: z.string().refine(isApprovalDocType, "Unknown document type."),
  // rupees as a decimal string; stored as integer paisa (never float)
  threshold: z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, "Invalid threshold."),
  isActive: z.boolean().default(true),
});

// GET /api/approvals/rules — the company's amount thresholds (settings perm)
export async function GET() {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const rules = await getApprovalRules(db, gate.companyId);
  return json({
    data: {
      docTypes: APPROVAL_DOC_TYPES,
      rules: rules.map((r) => ({
        id: r.id,
        docType: r.docType,
        threshold: (r.thresholdPaisa / 100n).toString(),
        thresholdPaisa: r.thresholdPaisa.toString(),
        isActive: r.isActive,
      })),
    },
  });
}

// POST /api/approvals/rules — create or replace the rule for one doc type
export async function POST(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const body = await req.json().catch(() => null);
  const parsed = ruleSchema.safeParse(body);
  if (!parsed.success) return err(parsed.error.issues[0]?.message ?? "Invalid rule.", 422);
  const docType = parsed.data.docType as ApprovalDocType;
  const thresholdPaisa = parseMoney(parsed.data.threshold);

  const oldRules = await getApprovalRules(db, companyId);
  const old = oldRules.find((r) => r.docType === docType);
  await db.transaction(async (tx) => {
    const existing = await tx
      .select({ id: approvalRules.id })
      .from(approvalRules)
      .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.docType, docType)))
      .limit(1);
    if (existing[0]) {
      await tx
        .update(approvalRules)
        .set({
          thresholdPaisa,
          isActive: parsed.data.isActive,
          updatedAt: new Date(),
        })
        .where(eq(approvalRules.id, existing[0].id));
    } else {
      await tx.insert(approvalRules).values({
        id: crypto.randomUUID(),
        companyId,
        docType,
        thresholdPaisa,
        isActive: parsed.data.isActive,
        createdById: session.uid,
      });
    }
  });
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "approval.rule.saved",
    entity: "approval_rule",
    entityId: docType,
    detail: `${docType}: amounts over Rs ${parsed.data.threshold} need approval${parsed.data.isActive ? "" : " (rule paused)"}`,
    ip: clientIp(req),
    oldValues: old
      ? { thresholdPaisa: old.thresholdPaisa.toString(), isActive: old.isActive }
      : null,
    newValues: { thresholdPaisa: thresholdPaisa.toString(), isActive: parsed.data.isActive },
  });
  return json({ data: { docType, thresholdPaisa: thresholdPaisa.toString() } }, { status: 201 });
}

// DELETE /api/approvals/rules?docType= — remove a rule (disables approvals for it)
export async function DELETE(req: NextRequest) {
  const gate = await requirePermission("settings");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;
  const docType = req.nextUrl.searchParams.get("docType") ?? "";
  if (!isApprovalDocType(docType)) return err("Unknown document type.", 422);
  const oldRules = await getApprovalRules(db, companyId);
  const old = oldRules.find((r) => r.docType === docType);
  await db
    .delete(approvalRules)
    .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.docType, docType)));
  await logAudit(db, {
    companyId,
    userId: session.uid,
    userName: session.name,
    action: "approval.rule.deleted",
    entity: "approval_rule",
    entityId: docType,
    detail: `Approval rule removed for ${docType}`,
    ip: clientIp(req),
    oldValues: old
      ? { thresholdPaisa: old.thresholdPaisa.toString(), isActive: old.isActive }
      : null,
  });
  return json({ data: { deleted: true } });
}
