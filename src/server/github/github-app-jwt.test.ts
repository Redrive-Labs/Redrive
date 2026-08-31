import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGithubAppJwt, GITHUB_JWT_LIFETIME_SECONDS } from "@/server/github/github-app-jwt";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

function decode(value: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("GitHub App JWT", () => {
  it("signs a short-lived RS256 JWT with the exact opaque App ID issuer", () => {
    const now = 1_800_000_000;
    const token = createGithubAppJwt({ appId: "9007199254740993123", privateKey, now });
    const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
    expect(decode(encodedHeader)).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decode(encodedPayload)).toEqual({
      iat: now - 60,
      exp: now + GITHUB_JWT_LIFETIME_SECONDS,
      iss: "9007199254740993123",
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify(publicKey, encodedSignature, "base64url")).toBe(true);
  });
});
