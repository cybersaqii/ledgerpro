import { SignJWT, jwtVerify } from "jose";
import { authSecretBytes } from "./auth-secret";

const secret = authSecretBytes();

/**
 * Short-lived MFA challenge token issued after password verification
 * when the user has MFA enabled. 5-minute expiry, single purpose.
 */
export async function createMfaChallengeToken(uid: string): Promise<string> {
  return new SignJWT({ uid, purpose: "mfa-challenge" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(secret);
}

export async function verifyMfaChallengeToken(token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    if (payload.purpose !== "mfa-challenge" || typeof payload.uid !== "string") return null;
    return payload.uid as string;
  } catch {
    return null;
  }
}
