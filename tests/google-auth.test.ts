import { describe, it, expect, beforeEach } from "vitest";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
} from "jose";
import {
  googleAuthUrl,
  signGoogleSignupToken,
  verifyGoogleIdToken,
  verifyGoogleSignupToken,
} from "@/lib/google";

const CLIENT_ID = "test-client-123";

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.GOOGLE_CLIENT_SECRET = "test-secret";
  process.env.AUTH_SECRET = "test-auth-secret-32-chars-minimum!!";
});

async function makeJwks() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = await exportJWK(publicKey);
  jwk.kid = "test-key";
  const jwks = createLocalJWKSet({ keys: [jwk] });
  return { jwks, privateKey };
}

async function signIdToken(
  privateKey: Parameters<typeof SignJWT.prototype.sign>[0],
  opts: { audience?: string; exp?: string } = {}
) {
  return new SignJWT({
    sub: "google-sub-42",
    email: "user@example.com",
    name: "Test User",
    email_verified: true,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("https://accounts.google.com")
    .setAudience(opts.audience ?? CLIENT_ID)
    .setExpirationTime(opts.exp ?? "2h")
    .sign(privateKey);
}

describe("verifyGoogleIdToken with a local JWKS", () => {
  it("extracts sub, email and name from a valid token", async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await signIdToken(privateKey);
    const claims = await verifyGoogleIdToken(token, jwks as never);
    expect(claims).toEqual({
      sub: "google-sub-42",
      email: "user@example.com",
      name: "Test User",
    });
  });

  it("rejects a token with the wrong audience", async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await signIdToken(privateKey, { audience: "someone-else" });
    await expect(verifyGoogleIdToken(token, jwks as never)).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const { jwks, privateKey } = await makeJwks();
    const token = await signIdToken(privateKey, { exp: "0s" });
    await expect(verifyGoogleIdToken(token, jwks as never)).rejects.toThrow();
  });
});

describe("google signup token", () => {
  it("round-trips", async () => {
    const input = {
      email: "new@example.com",
      name: "New User",
      googleSub: "google-sub-99",
    };
    const token = await signGoogleSignupToken(input);
    expect(await verifyGoogleSignupToken(token)).toEqual(input);
  });

  it("returns null for a tampered token", async () => {
    const token = await signGoogleSignupToken({
      email: "new@example.com",
      name: "New User",
      googleSub: "google-sub-99",
    });
    const tampered = token.slice(0, -4) + "abcd";
    expect(await verifyGoogleSignupToken(tampered)).toBeNull();
  });
});

describe("googleAuthUrl", () => {
  it("builds an OAuth authorize URL with code flow, openid scope and the callback redirect_uri", () => {
    const url = new URL(googleAuthUrl("state-xyz"));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://ledgerpro-pw5c.vercel.app/api/auth/google/callback"
    );
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
  });

  it("throws when not configured", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    expect(() => googleAuthUrl("s")).toThrow("Google sign-in is not configured");
  });
});
