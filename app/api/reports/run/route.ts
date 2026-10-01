import { NextRequest, NextResponse } from "next/server";
import { json } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import { requirePermission, db } from "@/lib/route-helpers";
import { requirePro } from "@/lib/billing-guards";
import { getFiscalYearStart } from "@/lib/year-end";
import { validateReportParams } from "@/lib/report-engine";
import { getPreset, listPresets, REPORT_CATEGORIES } from "@/lib/report-presets";
import { rowsToCsv, csvMoney } from "@/lib/csv";

// GET /api/reports/run — parametric report runner (Module 16).
//   ?key=<preset> — list mode (no key): returns the preset registry
//     (categories + per-preset meta: fields, defaults, perm, pro).
//   Run mode: ?key=trial-balance&from=2026-01-01&to=2026-12-31&groupBy=account…
//     plus &format=csv for a CSV download.
// Every run is company-isolated and permission-gated per preset.

function rawFromSearch(sp: URLSearchParams, defaults: Record<string, unknown>): Record<string, unknown> {
  const raw: Record<string, unknown> = { ...defaults };
  for (const [k, v] of sp.entries()) {
    if (k === "key" || k === "format") continue;
    raw[k] = v;
  }
  return raw;
}

export async function GET(req: NextRequest) {
  const gate = await requirePermission("reports_basic");
  if (!gate.ok) return gate.response;
  const { companyId } = gate;
  const sp = req.nextUrl.searchParams;
  const key = sp.get("key");

  // ——— Registry mode ———
  if (!key) {
    return json({
      data: {
        categories: REPORT_CATEGORIES,
        presets: listPresets().map((p) => ({
          key: p.key,
          category: p.category,
          perm: p.perm,
          pro: p.pro,
          titleKey: p.titleKey,
          descKey: p.descKey,
          fields: p.fields,
          defaults: p.defaults,
        })),
      },
    });
  }

  // ——— Run mode ———
  let preset;
  try {
    preset = getPreset(key);
  } catch (e) {
    return toApiError(e, { route: "/api/reports/run", companyId });
  }
  const pgate = await requirePermission(preset.perm);
  if (!pgate.ok) return pgate.response;
  if (preset.pro) {
    const pro = await requirePro("advanced_reports");
    if (!pro.ok) return pro.response;
  }

  let params;
  try {
    params = validateReportParams(rawFromSearch(sp, preset.defaults as Record<string, unknown>));
  } catch (e) {
    return toApiError(e, { route: "/api/reports/run", companyId });
  }

  try {
    const fyStart = await getFiscalYearStart(db, companyId).catch(() => "07-01");
    const result = await preset.run({ db, companyId, params, fyStart });

    if (sp.get("format") === "csv") {
      const headers = result.columns.map((c) => c.label);
      const moneySet = new Set(result.moneyCols ?? []);
      const body = result.rows.map((row) =>
        row.map((cell, i) => {
          const colKey = result.columns[i]?.key ?? "";
          if (moneySet.has(colKey)) return csvMoney(String(cell));
          return cell;
        })
      );
      const csv = rowsToCsv(headers, body);
      return new NextResponse("\uFEFF" + csv, {
        status: 200,
        headers: {
          "Content-Type": "text/csv;charset=utf-8",
          "Content-Disposition": `attachment; filename="${key}.csv"`,
        },
      });
    }

    return json({ data: { key, params, ...result } });
  } catch (e) {
    return toApiError(e, { route: "/api/reports/run", companyId });
  }
}
