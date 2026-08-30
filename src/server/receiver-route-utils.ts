import { NextResponse } from "next/server";
import {
  isValidOperatorSession,
  OPERATOR_SESSION_COOKIE,
} from "@/server/operator-auth";
import {
  ReceiverConnectionError,
  ReceiverConnectorAuthenticationError,
} from "@/server/receiver-connection-service";
import { ReceiverReadJobError } from "@/server/receiver-read-job-service";
import {
  ReceiverConnectorValidationError,
  type ReceiverConnection,
  type ReceiverReadJob,
} from "@/domain/receiver-connector";
import { ServerConfigurationError } from "@/server/config";

export const MAX_RECEIVER_REQUEST_BODY_BYTES = 64 * 1024;

export class ReceiverRouteBodyError extends Error {
  readonly status: 400 | 413 | 415;

  constructor(message: string, status: 400 | 413 | 415 = 400) {
    super(message);
    this.name = "ReceiverRouteBodyError";
    this.status = status;
  }
}

function response(
  body: Record<string, unknown>,
  status: number,
  headers?: HeadersInit,
): Response {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export async function readReceiverJson(
  request: Request,
  maxBytes = MAX_RECEIVER_REQUEST_BODY_BYTES,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    if (!/^\d+$/.test(normalized)) {
      throw new ReceiverRouteBodyError("Request body length is invalid.");
    }
    const declaredLength = Number(normalized);
    if (!Number.isSafeInteger(declaredLength) || declaredLength > maxBytes) {
      throw new ReceiverRouteBodyError("Request body is too large.", 413);
    }
  }

  if (request.body === null) {
    throw new ReceiverRouteBodyError("Request body is required.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let totalBytes = 0;
  let text = "";
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        try {
          text += decoder.decode();
        } catch {
          throw new ReceiverRouteBodyError("Request body contains malformed UTF-8.");
        }
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Keep the bounded body error.
        }
        throw new ReceiverRouteBodyError("Request body is too large.", 413);
      }
      try {
        text += decoder.decode(chunk.value, { stream: true });
      } catch {
        throw new ReceiverRouteBodyError("Request body contains malformed UTF-8.");
      }
    }
  } catch (error) {
    if (error instanceof ReceiverRouteBodyError) throw error;
    throw new ReceiverRouteBodyError("Request body is invalid.");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A cancelled or failed stream may already have released the lock.
    }
  }

  if (text.trim().length === 0) {
    throw new ReceiverRouteBodyError("Request body is required.");
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ReceiverRouteBodyError("Request body must be valid JSON.");
  }
}

function readCookieValue(request: Request, cookieName: string): string | null {
  const header = request.headers.get("cookie");
  if (header === null) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1 || part.slice(0, separator).trim() !== cookieName) {
      continue;
    }
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/** Route-local defense in depth for operator surfaces; proxy remains the first boundary. */
export function requireOperatorSession(request: Request): Response | null {
  const session = readCookieValue(request, OPERATOR_SESSION_COOKIE);
  if (isValidOperatorSession(session)) return null;
  return response({ error: "Unauthorized." }, 401);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(
  value: unknown,
  expected: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReceiverRouteBodyError(`${label} must be an object.`);
  }
  const expectedKeys = new Set(expected);
  const keys = Object.keys(value);
  if (
    keys.length !== expected.length ||
    keys.some((key) => !expectedKeys.has(key)) ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new ReceiverRouteBodyError(`${label} contains unexpected or missing fields.`);
  }
  return value;
}

export type ReceiverEnrollmentAction = "ISSUE" | "REISSUE";

export function parseReceiverEnrollmentAction(
  value: unknown,
): ReceiverEnrollmentAction {
  const record = assertExactKeys(value, ["action"], "Receiver enrollment request");
  if (record.action !== "ISSUE" && record.action !== "REISSUE") {
    throw new ReceiverRouteBodyError(
      "Receiver enrollment action must be ISSUE or REISSUE.",
    );
  }
  return record.action;
}

export type ReceiverCompletionRequest =
  | { leaseGeneration: unknown; outcome: "SUCCEEDED"; result: unknown }
  | { leaseGeneration: unknown; outcome: "FAILED"; errorCode: unknown };

export function parseReceiverCompletionRequest(
  value: unknown,
): ReceiverCompletionRequest {
  if (!isRecord(value)) {
    throw new ReceiverRouteBodyError("Receiver completion request must be an object.");
  }
  if (value.outcome === "SUCCEEDED") {
    const record = assertExactKeys(
      value,
      ["leaseGeneration", "outcome", "result"],
      "Receiver completion request",
    );
    return {
      leaseGeneration: record.leaseGeneration,
      outcome: "SUCCEEDED",
      result: record.result,
    };
  }
  if (value.outcome === "FAILED") {
    const record = assertExactKeys(
      value,
      ["leaseGeneration", "outcome", "errorCode"],
      "Receiver completion request",
    );
    return {
      leaseGeneration: record.leaseGeneration,
      outcome: "FAILED",
      errorCode: record.errorCode,
    };
  }
  throw new ReceiverRouteBodyError(
    "Receiver completion outcome must be SUCCEEDED or FAILED.",
  );
}

export function readReceiverConnectorCredentials(request: Request): {
  connectorId: string | undefined;
  connectorSecret: string | undefined;
} {
  const authorization = request.headers.get("authorization");
  if (authorization === null || !authorization.startsWith("Bearer ")) {
    return {
      connectorId: request.headers.get("x-redrive-connector-id") ?? undefined,
      connectorSecret: undefined,
    };
  }
  const secret = authorization.slice("Bearer ".length);
  if (secret.length === 0 || /\s/.test(secret)) {
    return {
      connectorId: request.headers.get("x-redrive-connector-id") ?? undefined,
      connectorSecret: undefined,
    };
  }
  return {
    connectorId: request.headers.get("x-redrive-connector-id") ?? undefined,
    connectorSecret: secret,
  };
}

export function toSafeReceiverConnection(
  receiverConnection: ReceiverConnection,
): Record<string, unknown> {
  // Keep this projection explicit so a future credential-bearing field cannot
  // become an API response merely by being added to the domain object.
  return {
    id: receiverConnection.id,
    applicationConnectionId: receiverConnection.applicationConnectionId,
    state: receiverConnection.state,
    enrollmentExpiresAt: receiverConnection.enrollmentExpiresAt,
    enrollmentConsumedAt: receiverConnection.enrollmentConsumedAt,
    connectorId: receiverConnection.connectorId,
    protocolVersion: receiverConnection.protocolVersion,
    capabilities: receiverConnection.capabilities,
    enrolledAt: receiverConnection.enrolledAt,
    lastSeenAt: receiverConnection.lastSeenAt,
    lastHealthStatus: receiverConnection.lastHealthStatus,
    lastHealthAt: receiverConnection.lastHealthAt,
    createdAt: receiverConnection.createdAt,
    updatedAt: receiverConnection.updatedAt,
  };
}

export function toReceiverLeasedJob(job: ReceiverReadJob): Record<string, unknown> {
  return {
    jobId: job.id,
    capability: job.capability,
    input: job.input,
    leaseGeneration: job.leaseGeneration,
    leaseExpiresAt: job.leaseExpiresAt,
    deadlineAt: job.deadlineAt,
  };
}

export function toReceiverCompletedJob(job: ReceiverReadJob): Record<string, unknown> {
  return {
    jobId: job.id,
    capability: job.capability,
    input: job.input,
    state: job.state,
    leaseGeneration: job.leaseGeneration,
    leaseExpiresAt: job.leaseExpiresAt,
    deadlineAt: job.deadlineAt,
    result: job.result,
    errorCode: job.errorCode,
    completedAt: job.completedAt,
  };
}

function receiverErrorDetails(error: ReceiverConnectionError | ReceiverReadJobError): {
  status: number;
  message: string;
  code?: string;
  authenticate?: boolean;
} {
  if (error instanceof ReceiverConnectionError) {
    switch (error.code) {
      case "UNAUTHENTICATED":
        return {
          status: 401,
          message: "Receiver connector authentication failed.",
          authenticate: true,
        };
      case "NOT_FOUND":
        return { status: 404, message: error.message };
      case "INVALID_INPUT":
        return { status: 400, message: error.message };
      case "TOKEN_INVALID":
      case "TOKEN_EXPIRED":
        return { status: 401, message: "The receiver enrollment token is invalid or expired." };
      case "CONFLICT":
      case "ENROLLMENT_REPLAY_MISMATCH":
      case "ALREADY_ENROLLED":
      case "INVALID_STATE":
        return { status: 409, message: error.message };
    }
  }

  switch (error.code) {
    case "INVALID_INPUT":
      return { status: 400, message: error.message };
    case "JOB_NOT_FOUND":
      return { status: 404, message: error.message };
    case "DEADLINE_EXPIRED":
    case "JOB_EXPIRED":
      return { status: 422, message: error.message, code: error.code };
    case "JOB_ALREADY_COMPLETED":
    case "JOB_NOT_LEASED":
    case "JOB_ALREADY_LEASED":
    case "JOB_NOT_AVAILABLE":
    case "STALE_LEASE":
    case "LEASE_EXPIRED":
    case "INVALID_STATE":
      return { status: 409, message: error.message, code: error.code };
  }
}

export function receiverErrorResponse(
  error: unknown,
  fallback = "Receiver request could not be completed.",
): Response {
  if (error instanceof ReceiverRouteBodyError) {
    return response({ error: error.message }, error.status);
  }
  if (error instanceof ReceiverConnectorValidationError) {
    return response({ error: error.message }, 400);
  }
  if (error instanceof ReceiverConnectionError || error instanceof ReceiverReadJobError) {
    const details = receiverErrorDetails(error);
    return response(
      {
        error: details.message,
        ...(details.code === undefined ? {} : { code: details.code }),
      },
      details.status,
      details.authenticate ? { "www-authenticate": "Bearer" } : undefined,
    );
  }
  if (error instanceof ServerConfigurationError) {
    return response({ error: "Receiver integration is not configured." }, 503);
  }
  return response({ error: fallback }, 503);
}

export function receiverAuthenticationErrorResponse(): Response {
  return response(
    { error: "Receiver connector authentication failed." },
    401,
    { "www-authenticate": "Bearer" },
  );
}

export function receiverMcpErrorResponse(): Response {
  return response({ error: "Receiver MCP is temporarily unavailable." }, 503);
}

export function isReceiverConnectorAuthenticationError(
  error: unknown,
): error is ReceiverConnectorAuthenticationError {
  return error instanceof ReceiverConnectorAuthenticationError;
}
