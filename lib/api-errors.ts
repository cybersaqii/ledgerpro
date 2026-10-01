/**
 * API error codes → localized UI strings.
 *
 * The API returns stable `code` fields on its most common user-facing
 * failures (see the optional `code` param of `err()` in lib/api.ts and
 * `UserError` in lib/errors.ts — e.g. "PERIOD_LOCKED", "INSUFFICIENT_STOCK",
 * "DUPLICATE"). This module maps those codes to i18n keys so a user in Urdu
 * mode sees a proper Urdu message instead of the English server text.
 *
 * Design rules:
 * - The table below is intentionally small: only codes the client actually
 *   localizes. Codes the server already sends but we don't translate
 *   (CREDIT_LIMIT_EXCEEDED is handled with a bespoke confirm dialog, sync
 *   protocol codes like OP_CONFLICT are machine-consumed) are NOT listed and
 *   fall through to the server message.
 * - Unknown / missing codes fall back to the server's `error` string, so
 *   behavior for uncoded errors is unchanged (English detail preserved).
 * - Keep this in sync with lib/sync-apply.ts `userErrorCode()` code names —
 *   the same stable vocabulary is used on the wire for sync clients.
 */

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

/** Stable API error code → i18n leaf key under the `errors` namespace. */
export const API_ERROR_I18N_KEY: Record<string, string> = {
  PERIOD_LOCKED: "errors.periodLocked",
  INSUFFICIENT_STOCK: "errors.insufficientStock",
  BELOW_MIN_PRICE: "errors.belowMinPrice",
  DUPLICATE: "errors.duplicate",
  NOT_FOUND: "errors.notFound",
  INVALID_CREDENTIALS: "errors.invalidCredentials",
  EMAIL_REGISTERED: "errors.emailRegistered",
  ACCOUNT_DEACTIVATED: "errors.accountDeactivated",
  INVALID_CODE: "errors.invalidCode",
  DOC_LOCKED: "errors.docLocked",
  DELETE_BLOCKED: "errors.deleteBlocked",
  VALIDATION_ERROR: "errors.validationError",
};

/** The i18n key for a known API error code, or null when the client doesn't localize it. */
export function apiErrorKey(code?: string | null): string | null {
  if (!code) return null;
  return API_ERROR_I18N_KEY[code] ?? null;
}

export type ApiFailure = {
  code?: string | null;
  message?: string | null;
};

/**
 * Localize an API failure for display: known code → translated string;
 * anything else → the server's message (current behavior); no message at
 * all → a generic localized fallback. Compatible with `ApiError`
 * (lib/format.ts) and with raw `{ code, error }` response bodies.
 */
export function localizedApiError(e: ApiFailure | null | undefined, t: TranslateFn, fallback?: string): string {
  const key = apiErrorKey(e?.code);
  if (key) return t(key);
  if (e?.message) return e.message;
  return fallback ?? t("errors.generic");
}
