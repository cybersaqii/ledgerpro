import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { err } from "@/lib/api";
import { googleAuthUrl, GOOGLE_STATE_COOKIE } from "@/lib/google";

export async function GET(_req: NextRequest) {
  if (!process.env.GOOGLE_CLIENT_ID) {
    return err("Google sign-in is not configured yet.", 503);
  }
  const state = randomBytes(32).toString("hex");
  const res = NextResponse.redirect(googleAuthUrl(state));
  res.cookies.set(GOOGLE_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 600,
  });
  return res;
}
