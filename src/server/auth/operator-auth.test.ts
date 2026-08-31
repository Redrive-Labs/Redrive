import { describe, expect, it } from "vitest";
import {
  createOperatorSession,
  isValidOperatorSession,
  operatorTokensMatch,
  OPERATOR_SESSION_LIFETIME_SECONDS,
  shouldUseSecureOperatorCookie,
} from "@/server/auth/operator-auth";

const token = "operator-token-that-is-at-least-32-characters";

function environment(value = token): NodeJS.ProcessEnv {
  return { REDRIVE_OPERATOR_TOKEN: value } as unknown as NodeJS.ProcessEnv;
}

describe("operator session", () => {
  it("creates and verifies a 12-hour signed session", () => {
    const session = createOperatorSession(environment(), 1_700_000_000);
    expect(session).toMatch(/^v1\.1700043200\.[A-Za-z0-9_-]+$/);
    expect(
      isValidOperatorSession(session, environment(), 1_700_000_000),
    ).toBe(true);
    expect(
      isValidOperatorSession(
        session,
        environment(),
        1_700_000_000 + OPERATOR_SESSION_LIFETIME_SECONDS,
      ),
    ).toBe(false);
  });

  it.each([
    null,
    "",
    "v2.1700043200.signature",
    "v1.not-a-number.signature",
    "v1.1700043200",
    "v1.1700043200.signature.extra",
    "v1.1700043200.bad.signature",
  ])("rejects malformed session %s", (session) => {
    expect(isValidOperatorSession(session, environment(), 1_700_000_000)).toBe(false);
  });

  it("rejects an expired session", () => {
    const session = createOperatorSession(environment(), 1_700_000_000);
    expect(
      isValidOperatorSession(session, environment(), 1_700_000_001 + OPERATOR_SESSION_LIFETIME_SECONDS),
    ).toBe(false);
  });

  it("rejects a tampered signature", () => {
    const session = createOperatorSession(environment(), 1_700_000_000) as string;
    const tampered = `${session.slice(0, -1)}${session.endsWith("a") ? "b" : "a"}`;
    expect(isValidOperatorSession(tampered, environment(), 1_700_000_000)).toBe(false);
  });

  it("invalidates an old session when the operator token changes", () => {
    const session = createOperatorSession(environment(), 1_700_000_000);
    expect(
      isValidOperatorSession(session, environment("a-different-token-that-is-also-long-enough"), 1_700_000_000),
    ).toBe(false);
  });

  it("fails closed for missing or short configuration", () => {
    expect(createOperatorSession({} as NodeJS.ProcessEnv, 1_700_000_000)).toBeNull();
    expect(
      createOperatorSession(environment("too-short"), 1_700_000_000),
    ).toBeNull();
    expect(operatorTokensMatch("submitted", token)).toBe(false);
  });
});

describe("operator cookie transport security", () => {
  const publicUrlEnvironment = {
    REDRIVE_PUBLIC_URL: "http://localhost",
  } as unknown as NodeJS.ProcessEnv;

  it.each([
    ["http://localhost", false],
    ["http://127.0.0.1:3000", false],
    ["http://[::1]:3000", false],
    ["https://localhost", true],
    ["https://redrive.example", true],
    ["http://redrive.example", true],
  ])("uses the actual request origin for %s", (requestUrl, expectedSecure) => {
    expect(
      shouldUseSecureOperatorCookie(requestUrl, publicUrlEnvironment),
    ).toBe(expectedSecure);
  });
});
