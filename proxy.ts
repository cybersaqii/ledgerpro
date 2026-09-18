import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "./lib/edge-auth";

// App routes live at top level (the (app) route group adds no path segment).
const APP_PREFIXES = [
  "/dashboard",
  "/sales",
  "/purchases",
  "/payments",
  "/expenses",
  "/parties",
  "/products",
  "/stock",
  "/reports",
];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const valid = token ? await verifySessionToken(token) : false;

  const isAppRoute = APP_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
  if (isAppRoute && !valid) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", pathname);
    return NextResponse.redirect(url);
  }

  if ((pathname === "/login" || pathname === "/signup") && valid) {
    const url = request.nextUrl.clone();
    url.pathname = "/dashboard";
    url.search = "";
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/dashboard/:path*",
    "/sales/:path*",
    "/purchases/:path*",
    "/payments/:path*",
    "/expenses/:path*",
    "/parties/:path*",
    "/products/:path*",
    "/stock/:path*",
    "/reports/:path*",
    "/login",
    "/signup",
  ],
};
