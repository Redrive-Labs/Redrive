import { NextResponse } from "next/server";
import {
  OPERATOR_SESSION_COOKIE,
  shouldUseSecureOperatorCookie,
} from "@/server/auth/operator-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set({
    name: OPERATOR_SESSION_COOKIE,
    value: "",
    expires: new Date(0),
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureOperatorCookie(request.url),
  });
  return response;
}
