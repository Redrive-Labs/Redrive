import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import {
  createOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/server/operator-auth";
import proxy from "./proxy";


const token = "operator-token-that-is-at-least-32-characters";
const originalEnvironment = { ...process.env };

function restoreEnvironment() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnvironment)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function request(pathname: string, session?: string): NextRequest {
  return new NextRequest(`http://localhost${pathname}`, {
    headers: session
      ? { cookie: `${OPERATOR_SESSION_COOKIE}=${session}` }
      : undefined,
  });
}

describe("operator proxy", () => {
  beforeEach(() => {
    process.env.REDRIVE_OPERATOR_TOKEN = token;
  });

  afterEach(restoreEnvironment);

  it("redirects an unauthenticated protected UI request to login", () => {
    const response = proxy(request("/"));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it("returns a JSON 401 for an unauthenticated protected API request", async () => {
    const response = proxy(request("/api/incidents"));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ error: "Unauthorized." });
  });

  it("allows a valid signed session to reach protected routes", () => {
    const session = createOperatorSession(process.env) as string;
    const response = proxy(request("/api/incidents", session));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each([
    "v1.1700000000.invalid",
    "not-a-session",
    "v1.1700000000",
  ])("rejects %s", (session) => {
    const response = proxy(request("/" , session));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("http://localhost/login");
  });

  it("rejects an expired session and a session signed by the old token", () => {
    const expired = createOperatorSession(
      process.env,
      Math.floor(Date.now() / 1000) - 1 - 12 * 60 * 60,
    ) as string;
    const expiredResponse = proxy(request("/", expired));
    expect(expiredResponse.status).toBe(307);

    const oldSession = createOperatorSession(process.env) as string;
    process.env.REDRIVE_OPERATOR_TOKEN = "a-new-operator-token-that-is-long-enough";
    const rotatedResponse = proxy(request("/", oldSession));
    expect(rotatedResponse.status).toBe(307);
  });

  it.each([
    "/login",
    "/api/operator/login",
    "/api/operator/logout",
    "/api/mcp/github",
    "/api/integrations/github/app-manifest/callback",
    "/api/integrations/github/install/callback",
    "/api/integrations/github/app-webhook-disabled",
  ])("keeps %s public", (pathname) => {
    const response = proxy(request(pathname));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it("does not use an operator cookie as authentication for the public MCP boundary", () => {
    const session = createOperatorSession(process.env) as string;
    const response = proxy(request("/api/mcp/github", session));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  it.each(["/_next/static/chunk.js", "/_next/image?url=%2Flogo.png&w=64&q=75"])(
    "allows login framework asset %s",
    (pathname) => {
      const response = proxy(request(pathname));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    },
  );
});
