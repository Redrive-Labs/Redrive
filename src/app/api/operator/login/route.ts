import { NextResponse } from "next/server";
import {
  createOperatorSession,
  getConfiguredOperatorToken,
  operatorTokensMatch,
  OPERATOR_SESSION_COOKIE,
  OPERATOR_SESSION_LIFETIME_SECONDS,
  parseOperatorToken,
  readBoundedRequestText,
  shouldUseSecureOperatorCookie,
} from "@/server/operator-auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  const body = await readBoundedRequestText(request);
  const submittedToken =
    body === null ? null : parseOperatorToken(body, request.headers.get("content-type"));
  const configuredToken = getConfiguredOperatorToken();

  if (configuredToken === null) {
    return NextResponse.json(
      { error: "Operator authentication is unavailable." },
      { status: 503 },
    );
  }
  if (
    submittedToken === null ||
    !operatorTokensMatch(submittedToken, configuredToken)
  ) {
    return NextResponse.json(
      { error: "Invalid operator token." },
      { status: 401 },
    );
  }

  const session = createOperatorSession();
  if (session === null) {
    return NextResponse.json(
      { error: "Operator authentication is unavailable." },
      { status: 503 },
    );
  }

  const response = NextResponse.redirect(new URL("/", request.url), 303);
  response.cookies.set({
    name: OPERATOR_SESSION_COOKIE,
    value: session,
    httpOnly: true,
    maxAge: OPERATOR_SESSION_LIFETIME_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: shouldUseSecureOperatorCookie(request.url),
  });
  return response;
}
