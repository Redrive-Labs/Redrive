import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const OPERATOR_SESSION_COOKIE = "redrive_operator_session";
export const OPERATOR_SESSION_LIFETIME_SECONDS = 12 * 60 * 60;
export const MAX_OPERATOR_LOGIN_BODY_BYTES = 4 * 1024;

const OPERATOR_SESSION_VERSION = "v1";
const MIN_OPERATOR_TOKEN_LENGTH = 32;
const MAX_SESSION_VALUE_LENGTH = 128;

/** Return the configured operator secret only when it meets the deployment contract. */
export function getConfiguredOperatorToken(
  environment: NodeJS.ProcessEnv = process.env,
): string | null {
  const token = environment.REDRIVE_OPERATOR_TOKEN;
  if (typeof token !== "string" || token.length < MIN_OPERATOR_TOKEN_LENGTH) {
    return null;
  }
  return token;
}

function timingSafeTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

/** Compare submitted and configured tokens without an early length-based compare. */
export function operatorTokensMatch(
  submittedToken: string,
  configuredToken: string,
): boolean {
  return timingSafeTextEqual(submittedToken, configuredToken);
}

function sessionSignature(versionAndExpiry: string, token: string): string {
  return createHmac("sha256", token)
    .update(versionAndExpiry, "utf8")
    .digest("base64url");
}

export function createOperatorSession(
  environment: NodeJS.ProcessEnv = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): string | null {
  const token = getConfiguredOperatorToken(environment);
  if (token === null || !Number.isSafeInteger(nowSeconds)) return null;

  const expiry = nowSeconds + OPERATOR_SESSION_LIFETIME_SECONDS;
  const versionAndExpiry = `${OPERATOR_SESSION_VERSION}.${expiry}`;
  return `${versionAndExpiry}.${sessionSignature(versionAndExpiry, token)}`;
}

/** Verify only the exact signed session format issued by createOperatorSession. */
export function isValidOperatorSession(
  value: string | null | undefined,
  environment: NodeJS.ProcessEnv = process.env,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const token = getConfiguredOperatorToken(environment);
  if (
    token === null ||
    typeof value !== "string" ||
    value.length > MAX_SESSION_VALUE_LENGTH ||
    !Number.isSafeInteger(nowSeconds)
  ) {
    return false;
  }

  const parts = value.split(".");
  if (parts.length !== 3 || parts[0] !== OPERATOR_SESSION_VERSION) return false;
  const expiryText = parts[1];
  const signature = parts[2];
  if (
    !/^(?:0|[1-9]\d*)$/.test(expiryText) ||
    !/^[A-Za-z0-9_-]+$/.test(signature)
  ) {
    return false;
  }

  const expiry = Number(expiryText);
  if (!Number.isSafeInteger(expiry) || expiry <= nowSeconds) return false;

  const expectedSignature = sessionSignature(
    `${OPERATOR_SESSION_VERSION}.${expiryText}`,
    token,
  );
  return timingSafeTextEqual(signature, expectedSignature);
}

/** Read a request body with a hard cap before parsing the token field. */
export async function readBoundedRequestText(
  request: Request,
  maxBytes = MAX_OPERATOR_LOGIN_BODY_BYTES,
): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) return null;
    const declaredLength = Number(contentLength);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      return null;
    }
  }

  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      totalBytes += next.value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  }

  const body = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
}

export function parseOperatorToken(
  body: string,
  contentType: string | null,
): string | null {
  const mediaType = contentType?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType === "application/x-www-form-urlencoded") {
    return new URLSearchParams(body).get("token");
  }
  if (mediaType === "application/json") {
    try {
      const parsed: unknown = JSON.parse(body);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "token" in parsed &&
        typeof parsed.token === "string"
      ) {
        return parsed.token;
      }
    } catch {
      // Treat malformed input as an invalid login, without exposing parse details.
    }
  }
  return null;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** Only an actual HTTP loopback request may receive a non-Secure cookie. */
export function shouldUseSecureOperatorCookie(
  requestUrl: string,
  // Kept for call-site compatibility; cookie security is never based on config alone.
  _environment?: NodeJS.ProcessEnv,
): boolean {
  try {
    const url = new URL(requestUrl);
    return !(url.protocol === "http:" && isLoopbackHostname(url.hostname));
  } catch {
    return true;
  }
}
