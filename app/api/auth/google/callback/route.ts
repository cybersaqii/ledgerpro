import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/db/schema";
import { createSession } from "@/lib/auth";
import { logAudit } from "@/lib/audit";
import { recordLoginEvent } from "@/lib/security";
import { clientIp } from "@/lib/rate-limit-db";
import {
  exchangeCodeForTokens,
  signGoogleSignupToken,
  verifyGoogleIdToken,
  GOOGLE_SIGNUP_COOKIE,
  GOOGLE_STATE_COOKIE,
} from "@/lib/google";

function appBase(): string {
  return (process.env.APP_URL || "https://ledgerpro-pw5c.vercel.app").replace(/\/+$/, "");
}

function loginRedirect(path: string): NextResponse {
  return NextResponse.redirect(new URL(path, appBase()));
}

function clearStateCookie(res: NextResponse): void {
  res.cookies.set(GOOGLE_STATE_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const oauthError = url.searchParams.get("error");
  const stateCookie = req.cookies.get(GOOGLE_STATE_COOKIE)?.value;

  // Consume the state cookie exactly once, whatever happens next.
  const failRedirect = loginRedirect("/login?error=google");
  clearStateCookie(failRedirect);

  if (oauthError) return failRedirect;
  if (!code || !state || !stateCookie || state !== stateCookie) {
    const stateRedirect = loginRedirect("/login?error=state");
    clearStateCookie(stateRedirect);
    return stateRedirect;
  }

  let sub: string;
  let email: string;
  let name: string;
  try {
    const { idToken } = await exchangeCodeForTokens(code);
    ({ sub, email, name } = await verifyGoogleIdToken(idToken));
  } catch {
    return failRedirect;
  }

  try {
    const now = new Date();

    // 1. Already linked Google account → straight in.
    let rows = await db.select().from(users).where(eq(users.googleSub, sub)).limit(1);
    let user = rows[0];

    if (!user) {
      // 2. Existing email/password account with the same verified email →
      //    link the Google identity and mark the email verified.
      rows = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
      user = rows[0];
      if (user) {
        await db
          .update(users)
          .set({ googleSub: sub, emailVerifiedAt: now })
          .where(eq(users.id, user.id));
        user = { ...user, googleSub: sub, emailVerifiedAt: now };
      }
    }

    if (!user) {
      // 3. Brand-new Google user → hand off to signup with a signed proof.
      const signupToken = await signGoogleSignupToken({ email, name, googleSub: sub });
      const res = NextResponse.redirect(new URL("/signup?google=1", appBase()));
      res.cookies.set(GOOGLE_SIGNUP_COOKIE, signupToken, {
        httpOnly: true,
        sameSite: "lax",
        secure: process.env.NODE_ENV === "production",
        path: "/",
        maxAge: 15 * 60,
      });
      return res;
    }

    if (!user.isActive) {
      return loginRedirect("/login?error=google");
    }

    await createSession({
      uid: user.id,
      cid: user.companyId,
      name: user.name,
      email: user.email,
      role: user.role,
      v: user.tokenVersion,
    });
    await db
      .update(users)
      .set({ lastLoginAt: now, lastActivityAt: now })
      .where(eq(users.id, user.id));
    await recordLoginEvent(db, {
      userId: user.id,
      companyId: user.companyId,
      ip: clientIp(req),
      userAgent: req.headers.get("user-agent"),
    });
    await logAudit(db, {
      companyId: user.companyId,
      userId: user.id,
      userName: user.name,
      action: "auth.login_google",
      entity: "user",
      entityId: user.id,
    });
    return NextResponse.redirect(new URL("/dashboard", appBase()));
  } catch {
    return failRedirect;
  }
}
