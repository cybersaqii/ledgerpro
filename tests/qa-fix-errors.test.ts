import { describe, it, expect } from "vitest";
import { tr, setUrDict } from "@/lib/i18n";
import { ur } from "@/lib/i18n/ur";
// The Urdu dictionary loads on demand in the app; tests inject it to stay synchronous.
setUrDict(ur);
import { err } from "@/lib/api";
import { UserError, toApiError } from "@/lib/errors";
import { ApiError } from "@/lib/format";
import { apiErrorKey, localizedApiError, API_ERROR_I18N_KEY } from "@/lib/api-errors";

const ten = (key: string, vars?: Record<string, string | number>) => tr("en", key, vars);
const tur = (key: string, vars?: Record<string, string | number>) => tr("ur", key, vars);

describe("apiErrorKey", () => {
  it("resolves known codes to i18n keys", () => {
    expect(apiErrorKey("PERIOD_LOCKED")).toBe("errors.periodLocked");
    expect(apiErrorKey("INSUFFICIENT_STOCK")).toBe("errors.insufficientStock");
    expect(apiErrorKey("DUPLICATE")).toBe("errors.duplicate");
  });
  it("returns null for unknown, empty, or missing codes", () => {
    expect(apiErrorKey("OP_CONFLICT")).toBeNull(); // sync-internal code, not localized
    expect(apiErrorKey("CREDIT_LIMIT_EXCEEDED")).toBeNull(); // bespoke confirm dialog, not a plain toast
    expect(apiErrorKey("NOPE")).toBeNull();
    expect(apiErrorKey("")).toBeNull();
    expect(apiErrorKey(null)).toBeNull();
    expect(apiErrorKey(undefined)).toBeNull();
  });
});

describe("localizedApiError", () => {
  it("maps a known code to English in EN mode", () => {
    const out = localizedApiError({ code: "PERIOD_LOCKED", message: "Books are locked up to 2026-01-01." }, ten);
    expect(out).toBe("Books are locked for this date. Entries on or before the lock date cannot be added or changed.");
  });
  it("maps a known code to Urdu in UR mode", () => {
    const out = localizedApiError({ code: "PERIOD_LOCKED", message: "Books are locked up to 2026-01-01." }, tur);
    expect(out).toBe("اس تاریخ کا حساب بند (لاک) ہے۔ لاک تاریخ سے پہلے یا اس پر اندراج نہیں ہو سکتا۔");
  });
  it("works directly with the ApiError thrown by the api() helper", () => {
    const e = new ApiError("A product with this SKU already exists.", "DUPLICATE");
    expect(localizedApiError(e, ten)).toBe("A record with the same name or code already exists.");
    expect(localizedApiError(e, tur)).toBe("اسی نام یا کوڈ کا ریکارڈ پہلے سے موجود ہے۔");
  });
  it("passes unknown codes through to the server message (current behavior)", () => {
    const out = localizedApiError({ code: "SOME_FUTURE_CODE", message: "Server said something in English." }, tur);
    expect(out).toBe("Server said something in English.");
  });
  it("passes codeless errors through to the server message", () => {
    expect(localizedApiError({ message: "Plain English detail." }, tur)).toBe("Plain English detail.");
    expect(localizedApiError(null, ten, "Save failed.")).toBe("Save failed.");
  });
  it("falls back to the generic localized string when there is no message", () => {
    expect(localizedApiError({}, ten)).toBe("Something went wrong. Please try again.");
    expect(localizedApiError(null, tur)).toBe("کچھ غلط ہو گیا۔ براہ کرم دوبارہ کوشش کریں۔");
  });
  it("every mapped code resolves to a real string in both languages", () => {
    for (const [code, key] of Object.entries(API_ERROR_I18N_KEY)) {
      const enStr = ten(key);
      const urStr = tur(key);
      expect(enStr, `${code} en`).not.toBe(key);
      expect(urStr, `${code} ur`).not.toBe(key);
      expect(urStr, `${code} ur != en`).not.toBe(enStr);
    }
  });
});

describe("err() code field (additive)", () => {
  it("includes the code in the JSON body when given", async () => {
    const res = err("A product with this SKU already exists.", 409, "DUPLICATE");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("A product with this SKU already exists.");
    expect(body.code).toBe("DUPLICATE");
  });
  it("omits the code field when not given (old call sites unchanged)", async () => {
    const res = err("Old style error.", 400);
    const body = await res.json();
    expect(body.error).toBe("Old style error.");
    expect("code" in body).toBe(false);
  });
});

describe("UserError code passthrough", () => {
  it("carries the code and toApiError surfaces it", async () => {
    const res = await toApiError(new UserError("Nope", 422, "INSUFFICIENT_STOCK"), { route: "/api/test" });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.code).toBe("INSUFFICIENT_STOCK");
  });
  it("UserError without a code keeps the old shape", async () => {
    const res = await toApiError(new UserError("Old style."), { route: "/api/test" });
    const body = await res.json();
    expect(body.error).toBe("Old style.");
    expect("code" in body).toBe(false);
  });
});
