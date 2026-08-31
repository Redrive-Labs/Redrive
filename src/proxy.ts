import { NextRequest, NextResponse } from "next/server";
import {
  isValidOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/server/auth/operator-auth";

const PUBLIC_PATHS = new Set([
  "/login",
  "/api/operator/login",
  // Logout only expires the cookie and must also clear stale sessions.
  "/api/operator/logout",
  "/api/mcp/github",
  "/api/mcp/receiver",
  "/api/receiver/enroll",
  "/api/integrations/github/app-manifest/callback",
  "/api/integrations/github/install/callback",
  "/api/integrations/github/app-webhook-disabled",
]);

function isPublicPath(pathname: string): boolean {
  const normalizedPathname =
    pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  return (
    PUBLIC_PATHS.has(normalizedPathname) ||
    normalizedPathname === "/api/receiver/jobs/lease" ||
    /^\/api\/receiver\/jobs\/[^/]+\/complete$/.test(normalizedPathname)
  );
}

function isFrameworkAsset(pathname: string): boolean {
  return (
    pathname === "/favicon.ico" ||
    pathname.startsWith("/_next/static/") ||
    (pathname === "/_next/image" || pathname.startsWith("/_next/image/"))
  );
}

export function proxy(request: NextRequest): NextResponse {
  const pathname = request.nextUrl.pathname;
  if (isPublicPath(pathname) || isFrameworkAsset(pathname)) {
    return NextResponse.next();
  }

  const session = request.cookies.get(OPERATOR_SESSION_COOKIE)?.value;
  if (isValidOperatorSession(session)) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = "/login";
  loginUrl.search = "";
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

export default proxy;
