import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { POST } from "./route";

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

describe("operator login route", () => {
  beforeEach(() => {
    process.env.REDRIVE_OPERATOR_TOKEN = token;
    delete process.env.REDRIVE_PUBLIC_URL;
  });

  afterEach(restoreEnvironment);

  it("sets an HttpOnly signed session cookie and redirects after valid login", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("http://localhost/");
    const cookie = response.headers.get("set-cookie");
    expect(cookie).toContain("redrive_operator_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Max-Age=43200");
    expect(cookie).toContain("Path=/");
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).not.toContain(token);
    expect(cookie).not.toContain("Secure");
  });

  it("sets no session cookie for an invalid token", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: "wrong-operator-token" }),
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    await expect(response.json()).resolves.toEqual({ error: "Invalid operator token." });
  });

  it.each([undefined, "short-token"]) (
    "fails closed when REDRIVE_OPERATOR_TOKEN is %s",
    async (configuredToken) => {
      if (configuredToken === undefined) delete process.env.REDRIVE_OPERATOR_TOKEN;
      else process.env.REDRIVE_OPERATOR_TOKEN = configuredToken;

      const response = await POST(
        new Request("http://localhost/api/operator/login", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ token }),
        }),
      );

      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      await expect(response.json()).resolves.toEqual({
        error: "Operator authentication is unavailable.",
      });
    },
  );

  it("bounds the login body without echoing submitted data", async () => {
    const response = await POST(
      new Request("http://localhost/api/operator/login", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: `token=${"x".repeat(4096)}`,
      }),
    );

    expect(response.status).toBe(401);
    expect(await response.text()).not.toContain("x".repeat(100));
  });

  it("uses the actual HTTPS request when REDRIVE_PUBLIC_URL is HTTP", async () => {
    process.env.REDRIVE_PUBLIC_URL = "http://localhost";
    const response = await POST(
      new Request("https://redrive.example/api/operator/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token }),
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("set-cookie")).toContain("Secure");
  });
});
