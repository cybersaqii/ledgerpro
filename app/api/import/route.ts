import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { importLogs } from "@/db/schema";
import { json, err } from "@/lib/api";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { toApiError, UserError } from "@/lib/errors";
import { logAudit } from "@/lib/audit";
import {
  parseCSV,
  autoMapFields,
  fieldsFor,
  validateImport,
  commitImport,
  parseKind,
  MAX_ROWS,
  MAX_BYTES,
  MAX_ERRORS,
  type ImportKind,
} from "@/lib/importer";

// POST /api/import — universal CSV import (Module 20).
// multipart/form-data: file (CSV), kind=products|parties|opening_stock,
// mode=validate|import (default validate), mapping (optional JSON
// { field: columnIndex } — auto-guessed from headers when absent).
//
// Two-pass by design: "validate" runs both validation passes and returns
// every error with its CSV row number, committing NOTHING. "import"
// re-validates and commits ALL rows in one transaction ONLY when the error
// count is zero — otherwise it answers 422 and logs a FAILED attempt.
// Every commit attempt is written to import_logs.
//
// Excel files: save as CSV in Excel first (File → Save As → CSV), then
// upload — the wizard documents this; only CSV is parsed.

function sanitizeMapping(
  raw: unknown,
  kind: ImportKind
): Record<string, number | null> {
  const fields = fieldsFor(kind).map((f) => f.field);
  const out: Record<string, number | null> = {};
  for (const f of fields) out[f] = null;
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!fields.includes(k)) continue;
      out[k] =
        typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100 ? v : null;
    }
  }
  return out;
}

export async function POST(req: NextRequest) {
  const gate = await requirePermission("import_export");
  if (!gate.ok) return gate.response;
  const { session, companyId } = gate;

  const form = await req.formData().catch(() => null);
  const pro = await requirePro("import_export");
  if (!pro.ok) return pro.response;

  try {
    const kind = parseKind(form?.get("kind"));
    const file = form?.get("file");
    if (!(file instanceof File)) throw new UserError("Please attach a CSV file.", 422);
    if (file.size > MAX_BYTES)
      throw new UserError(`File is too large (max ${MAX_BYTES / 1024 / 1024} MB).`, 422);
    const modeRaw = form?.get("mode");
    const mode = modeRaw === "import" ? "import" : "validate";

    const text = await file.text().catch(() => "");
    if (!text.trim()) throw new UserError("The file is empty.", 422);
    const rows = parseCSV(text);
    if (rows.length < 2)
      throw new UserError("No data rows found. Keep the header row and add data below it.", 422);
    if (rows.length - 1 > MAX_ROWS)
      throw new UserError(`Too many rows (max ${MAX_ROWS}). Split the file and try again.`, 422);

    let mapping: Record<string, number | null>;
    try {
      const rawMapping = form?.get("mapping");
      mapping =
        typeof rawMapping === "string" && rawMapping.trim()
          ? sanitizeMapping(JSON.parse(rawMapping), kind)
          : autoMapFields(rows[0], fieldsFor(kind));
    } catch {
      throw new UserError("The column mapping is invalid.", 422, "VALIDATION_ERROR");
    }

    const result = await validateImport(db, companyId, kind, rows, mapping);
    const fileName = file.name?.slice(0, 120) ?? null;

    if (mode === "validate") {
      return json({
        data: {
          kind,
          totalRows: result.totalRows,
          validCount: result.valid.length,
          skipped: result.skipped,
          errorCount: result.errorCount,
          errors: result.errors,
        },
      });
    }

    // mode = import: all-or-nothing.
    if (result.errorCount > 0) {
      await db.insert(importLogs).values({
        id: crypto.randomUUID(),
        companyId,
        kind: kind.toUpperCase(),
        fileName,
        totalRows: result.totalRows,
        importedRows: 0,
        skippedRows: result.skipped,
        errorCount: result.errorCount,
        errorsJson: JSON.stringify(result.errors.slice(0, MAX_ERRORS)),
        status: "FAILED",
        createdById: session.uid,
      });
      return NextResponse.json(
        {
          error: `Fix ${result.errorCount} row${result.errorCount === 1 ? "" : "s"} before importing — nothing was saved.`,
          code: "IMPORT_VALIDATION_FAILED",
          data: {
            totalRows: result.totalRows,
            skipped: result.skipped,
            errorCount: result.errorCount,
            errors: result.errors,
          },
        },
        { status: 422 }
      );
    }

    const committed = await db.transaction(async (tx) => {
      const res = await commitImport(tx, companyId, session.uid, kind, result.valid);
      await tx.insert(importLogs).values({
        id: crypto.randomUUID(),
        companyId,
        kind: kind.toUpperCase(),
        fileName,
        totalRows: result.totalRows,
        importedRows: res.imported,
        skippedRows: result.skipped,
        errorCount: 0,
        errorsJson: null,
        status: "SUCCESS",
        createdById: session.uid,
      });
      return res;
    });

    await logAudit(db, {
      companyId,
      userId: session.uid,
      userName: session.name,
      action: "data.imported",
      entity: "import",
      detail: `CSV import (${kind}): ${committed.imported} imported, ${result.skipped} skipped`,
    });
    return json({
      data: {
        kind,
        imported: committed.imported,
        skipped: result.skipped,
        totalRows: result.totalRows,
      },
    });
  } catch (e) {
    return toApiError(e, { route: "/api/import", companyId });
  }
}

// GET /api/import?log=1 — recent import attempts for this company.
// GET /api/import?kind=products|parties|opening_stock — sample CSV template.
export async function GET(req: NextRequest) {
  const gate = await requirePermission("import_export");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  if (req.nextUrl.searchParams.get("log") === "1") {
    const rows = await db
      .select()
      .from(importLogs)
      .where(eq(importLogs.companyId, companyId))
      .orderBy(desc(importLogs.createdAt))
      .limit(50);
    return json({
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        fileName: r.fileName,
        totalRows: r.totalRows,
        importedRows: r.importedRows,
        skippedRows: r.skippedRows,
        errorCount: r.errorCount,
        errors: r.errorsJson ? JSON.parse(r.errorsJson as string) : [],
        status: r.status,
        createdAt: r.createdAt,
      })),
    });
  }
  const kind = req.nextUrl.searchParams.get("kind");
  if (kind === "products") {
    const csv =
      "SKU,Name,Barcode,Category,Unit,Purchase Price,Sale Price,Track Stock\r\nTEA-001,Test Tea,,Grocery,PCS,200,250,Yes\r\n";
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="products-template.csv"',
      },
    });
  }
  if (kind === "parties") {
    const csv =
      "Name,Type,Phone,Email,Address,City,Credit Limit\r\nAhmed Store,CUSTOMER,03001234567,,,Lahore,50000\r\n";
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="parties-template.csv"',
      },
    });
  }
  if (kind === "opening_stock") {
    const csv = "SKU,Quantity,Unit Cost\r\nTEA-001,100,200\r\n";
    return new NextResponse("﻿" + csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="opening-stock-template.csv"',
      },
    });
  }
  return err("Unknown template kind.", 400);
}
