// Edge-safe session check for proxy.ts — imports ONLY jose (edge-compatible).
import { jwtVerify } from "jose";

export const SESSION_COOKIE = "ledgerpro_session";

const secret = new TextEncoder().encode(
  process.env.AUTH_SECRET || "dev-only-secret-change-me-32-chars-min"
);

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return !!(payload.uid && payload.cid);
  } catch {
    return false;
  }
}
