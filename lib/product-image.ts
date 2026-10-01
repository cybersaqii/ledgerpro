// Product image URLs: external https only, validated server-side on write.
// Uploads are intentionally not stored on our servers (keeps the free-tier
// stack at Rs 0) — the owner pastes an image link; the UI falls back to a
// professional generated tile when absent or broken.

const MAX_LEN = 500;

export class ImageUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageUrlError";
  }
}

/** Normalize + validate. Returns null for empty, throws ImageUrlError on bad input. */
export function validateImageUrl(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (s.length > MAX_LEN) throw new ImageUrlError("Image link is too long.");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new ImageUrlError("Enter a valid image link (https://…).");
  }
  if (u.protocol !== "https:") throw new ImageUrlError("Image link must start with https://");
  if (u.username || u.password) throw new ImageUrlError("Image link must not contain credentials.");
  // Block localhost / private-network targets (SSRF hygiene even though we never fetch server-side).
  // Trailing dots are stripped first: "localhost." is still localhost.
  const host = u.hostname.toLowerCase().replace(/\.*$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "127.0.0.1" ||
    host === "[::1]" ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new ImageUrlError("Image link must be a public internet address.");
  }
  return u.toString();
}
