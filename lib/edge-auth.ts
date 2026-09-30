// Edge-safe session check for proxy.ts — imports ONLY jose (edge-compatible).
import { jwtVerify } from "jose";
import { authSecretBytes } from "./auth-secret";

export const SESSION_COOKIE = "ledgerpro_session";

const secret = authSecretBytes();

export async function verifySessionToken(token: string): Promise<boolean> {
  try {
    const { payload } = await jwtVerify(token, secret);
    return !!(payload.uid && payload.cid);
  } catch {
    return false;
  }
}
