// Regression test for the ERR_TOO_MANY_REDIRECTS loop reported 2026-10-02:
//
// The edge proxy (proxy.ts) treats a session as valid from the JWT signature
// alone, while getSession() also enforces DB state (tokenVersion, isActive,
// idle timeout). A cookie can therefore be cryptographically valid yet dead
// server-side (e.g. the 24h idle timeout expiring after the browser was
// closed). Before the fix, the (app) layout redirected such requests to
// /login directly, so the proxy bounced /login back to /dashboard, which
// bounced to /login again — forever.
//
// The fix: the layout routes dead sessions through GET /api/auth/expired,
// which deletes the stale cookie (cookie mutation is only allowed in Route
// Handlers) and then redirects to /login. Proxy and layout agree again, so
// /login renders instead of looping.

import { describe, it, expect, vi, beforeEach } from "vitest";

const REDIRECT_SENTINEL = "NEXT_REDIRECT_SENTINEL";

const navState = vi.hoisted(() => ({
  redirectUrl: null as string | null,
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    navState.redirectUrl = url;
    throw new Error(REDIRECT_SENTINEL);
  },
}));

import { requireSession, SESSION_COOKIE, type Session } from "@/lib/auth";
import { GET as expiredGet } from "@/app/api/auth/expired/route";

const fakeSession: Session = {
  uid: "u1",
  cid: "c1",
  name: "Test",
  email: "t@example.com",
  role: "OWNER",
  v: 1,
};

beforeEach(() => {
  navState.redirectUrl = null;
});

describe("requireSession", () => {
  it("returns a valid session untouched (no redirect)", async () => {
    const out = await requireSession(fakeSession);
    expect(out).toBe(fakeSession);
    expect(navState.redirectUrl).toBeNull();
  });

  it("routes a dead session through /api/auth/expired (never straight to /login)", async () => {
    await expect(requireSession(null)).rejects.toThrow(REDIRECT_SENTINEL);
    // Straight to /login would re-trigger the proxy bounce loop.
    expect(navState.redirectUrl).toBe("/api/auth/expired");
  });
});

describe("GET /api/auth/expired", () => {
  it("deletes the stale session cookie and redirects to /login", async () => {
    const res = await expiredGet(new Request("http://localhost/api/auth/expired"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("http://localhost/login");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain(`${SESSION_COOKIE}=`);
    // A deletion, not a value: empty + already-expired.
    expect(setCookie).toMatch(/expires=Thu, 01 Jan 1970/i);
  });
});
