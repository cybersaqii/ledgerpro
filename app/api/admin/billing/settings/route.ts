import { NextRequest } from "next/server";
import { json, err } from "@/lib/api";
import { toApiError } from "@/lib/errors";
import {
  requirePlatformAdmin,
  getPlatformSettings,
  setPlatformSetting,
  PLATFORM_SETTING_KEYS,
} from "@/lib/billing-guards";

// GET /api/admin/billing/settings — platform admin: read billing settings.
export async function GET() {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  const settings = await getPlatformSettings();
  return json({ data: settings });
}

// PUT /api/admin/billing/settings — platform admin: update prices, payment
// instructions and support contact details.
// { key: value, ... } — only known platform.* keys are accepted.
export async function PUT(req: NextRequest) {
  const gate = await requirePlatformAdmin();
  if (!gate.ok) return gate.response;
  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") return err("Nothing to update.", 422);
    const allowed = new Set<string>(PLATFORM_SETTING_KEYS);
    let updated = 0;
    for (const [key, value] of Object.entries(body)) {
      if (!allowed.has(key)) continue;
      const v = String(value ?? "").trim();
      if (key.endsWith("_paisa")) {
        const n = parseInt(v, 10);
        if (!Number.isFinite(n) || n <= 0) return err("Prices must be positive numbers (in paisa).", 422);
        await setPlatformSetting(key, String(n));
      } else {
        if (v.length > 500) return err("Text is too long.", 422);
        await setPlatformSetting(key, v);
      }
      updated++;
    }
    if (!updated) return err("Nothing to update.", 422);
    return json({ data: { updated } });
  } catch (e) {
    return toApiError(e, { route: "/api/admin/billing/settings", companyId: null });
  }
}
