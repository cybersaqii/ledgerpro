import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";
import { authSecretBytes } from "./auth-secret";

export const GOOGLE_STATE_COOKIE = "g_oauth_state";
export const GOOGLE_SIGNUP_COOKIE = "g_signup";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

function appUrl(): string {
  return (process.env.APP_URL || "https://ledgerpro-pw5c.vercel.app").replace(/\/+$/, "");
}

export function callbackUrl(): string {
  return `${appUrl()}/api/auth/google/callback`;
}

function requireConfig(): { clientId: string; clientSecret: string } {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Google sign-in is not configured");
  }
  return { clientId, clientSecret };
}

export function googleAuthUrl(state: string): string {
  const { clientId } = requireConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl(),
    response_type: "code",
    scope: "openid email profile",
    state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(code: string): Promise<{ idToken: string }> {
  const { clientId, clientSecret } = requireConfig();
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: callbackUrl(),
      grant_type: "authorization_code",
    }),
  });
  if (!res.ok) {
    throw new Error("Google token exchange failed");
  }
  const body = (await res.json()) as { id_token?: string };
  if (!body.id_token) {
    throw new Error("Google token exchange failed");
  }
  return { idToken: body.id_token };
}

type JwksGetter = (protectedHeader?: { kid?: string }, token?: unknown) => Promise<unknown>;

const defaultJwks = createRemoteJWKSet(new URL(JWKS_URL));

export async function verifyGoogleIdToken(
  idToken: string,
  getKey: JwksGetter = defaultJwks as unknown as JwksGetter
): Promise<{ sub: string; email: string; name: string }> {
  const { clientId } = requireConfig();
  const { payload } = await jwtVerify(
    idToken,
    getKey as Parameters<typeof jwtVerify>[1],
    { issuer: ISSUERS, audience: clientId }
  );
  const sub = payload.sub;
  const email = payload.email;
  const name = payload.name;
  if (!sub || !email || typeof email !== "string") {
    throw new Error("Google token is missing a verified email");
  }
  if (payload.email_verified === false) {
    throw new Error("Google email is not verified");
  }
  return { sub, email, name: typeof name === "string" ? name : "" };
}

// ─── Google signup token (short-lived, carried in GOOGLE_SIGNUP_COOKIE) ─────
// Used when the Google account has no LedgerProSolution user yet: the callback mints
// one of these and the signup form submits it with account creation, so the
// "google-verified email" proof can't be obtained by skipping OAuth.

export interface GoogleSignupClaims {
  email: string;
  name: string;
  googleSub: string;
}

function signupSecret(): Uint8Array {
  return authSecretBytes();
}

export async function signGoogleSignupToken(input: GoogleSignupClaims): Promise<string> {
  return new SignJWT({ kind: "google-signup", ...input })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(signupSecret());
}

export async function verifyGoogleSignupToken(token: string): Promise<GoogleSignupClaims | null> {
  try {
    const { payload } = await jwtVerify(token, signupSecret());
    const p = payload as unknown as Record<string, unknown>;
    if (p.kind !== "google-signup") return null;
    if (typeof p.email !== "string" || typeof p.name !== "string" || typeof p.googleSub !== "string") return null;
    return { email: p.email, name: p.name, googleSub: p.googleSub };
  } catch {
    return null;
  }
}
