import { createSign } from "node:crypto";
import { readOpaqueGithubIdentifier } from "@/domain/github-integration";

export const GITHUB_JWT_LIFETIME_SECONDS = 9 * 60;
export const GITHUB_JWT_CLOCK_SKEW_SECONDS = 60;

export class GithubAppJwtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubAppJwtError";
  }
}

function base64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function createGithubAppJwt(options: {
  appId: string;
  privateKey: string;
  now?: Date | number;
}): string {
  let appId: string;
  try {
    appId = readOpaqueGithubIdentifier(options.appId, "App ID");
  } catch {
    throw new GithubAppJwtError("A valid GitHub App ID is required.");
  }
  if (
    typeof options.privateKey !== "string" ||
    options.privateKey.length === 0
  ) {
    throw new GithubAppJwtError("A GitHub App private key is required.");
  }

  const nowMilliseconds =
    options.now instanceof Date
      ? options.now.getTime()
      : typeof options.now === "number"
        ? options.now * 1000
        : Date.now();
  if (!Number.isFinite(nowMilliseconds)) {
    throw new GithubAppJwtError("The GitHub App JWT clock is invalid.");
  }
  const nowSeconds = Math.floor(nowMilliseconds / 1000);
  const payload = {
    iat: nowSeconds - GITHUB_JWT_CLOCK_SKEW_SECONDS,
    exp: nowSeconds + GITHUB_JWT_LIFETIME_SECONDS,
    iss: appId,
  };
  const encodedHeader = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(options.privateKey).toString("base64url");
    return `${signingInput}.${signature}`;
  } catch {
    // Never expose the PEM or crypto-library details in a route-visible error.
    throw new GithubAppJwtError("The GitHub App JWT could not be signed.");
  }
}
