// Single source for the JWT signing secret.
//
// H3 fix: in production, a missing AUTH_SECRET used to silently fall back to a
// publicly visible dev key (full session forgery). Now it throws at first use
// so a misconfigured deploy fails loudly instead of running insecure.
export function authSecretBytes(): Uint8Array {
  const s = process.env.AUTH_SECRET;
  if (!s) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET is not set — refusing to sign tokens with the dev fallback.");
    }
    return new TextEncoder().encode("dev-only-secret-change-me-32-chars-min");
  }
  if (s.length < 32) {
    // Weak secrets are still honored in dev, but never in production.
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET must be at least 32 characters in production.");
    }
  }
  return new TextEncoder().encode(s);
}
