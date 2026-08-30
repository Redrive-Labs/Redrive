import {
  CapabilityValidationError,
  parseCapabilityJob,
  parseCapabilityResult,
  RECEIVER_CAPABILITIES,
  type CapabilityJob,
  type ConnectorIdentity,
} from "./model.js";
import { TransportError } from "./errors.js";
import { normalizeRedriveOrigin } from "./redrive-url.js";
import type {
  CompleteRequest,
  EnrollmentRequest,
  EnrollmentResult,
  FailRequest,
  LeaseRequest,
  RedriveTransport,
} from "./transport.js";

export const DEFAULT_ENROLLMENT_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_LEASE_TIMEOUT_MS = 25_000 as const;
export const DEFAULT_COMPLETION_TIMEOUT_MS = 15_000 as const;
export const DEFAULT_TRANSPORT_MAX_RESPONSE_BYTES = 64 * 1024;

const REDRIVE_CONNECTOR_PROTOCOL_VERSION = "1" as const;

type TransportOperation = "enroll" | "lease" | "completion";

export interface ConcreteRedriveHttpTransportOptions {
  readonly redriveUrl: string;
  readonly fetchImpl?: typeof fetch;
  readonly enrollmentTimeoutMs?: number;
  readonly leaseTimeoutMs?: number;
  readonly completionTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeOrigin(value: string): string {
  const origin = normalizeRedriveOrigin(value);
  if (origin === null) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The configured Redrive URL must be an HTTP(S) origin.",
      false,
    );
  }
  return origin;
}

function positiveBound(
  value: number | undefined,
  fallback: number,
  maximum: number,
  message: string,
): number {
  const bound = value ?? fallback;
  if (!Number.isSafeInteger(bound) || bound <= 0 || bound > maximum) {
    throw new TransportError("TRANSPORT_REJECTED", message, false);
  }
  return bound;
}

function boundedText(value: unknown, field: string, maximumLength: number): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TransportError(
      "TRANSPORT_MALFORMED_RESPONSE",
      `Central ${field} was malformed.`,
      false,
    );
  }
  return value;
}

function validateIdentityText(
  value: unknown,
  maximumLength: number,
): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector identity is invalid.",
      false,
    );
  }
}

function validateCapabilities(value: readonly string[]): void {
  if (
    !Array.isArray(value) ||
    value.length !== RECEIVER_CAPABILITIES.length ||
    value[0] !== RECEIVER_CAPABILITIES[0] ||
    value[1] !== RECEIVER_CAPABILITIES[1]
  ) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector capability set is invalid.",
      false,
    );
  }
}

function validateIdentity(identity: ConnectorIdentity, origin: string): void {
  let identityOrigin: string;
  try {
    identityOrigin = normalizeOrigin(identity.serverOrigin);
  } catch {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector identity is invalid.",
      false,
    );
  }
  if (identityOrigin !== origin) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector identity is bound to another Redrive origin.",
      false,
    );
  }
  validateIdentityText(identity.connectorId, 255);
  validateIdentityText(identity.connectorSecret, 4096);
  if (/\s/.test(identity.connectorSecret)) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector identity is invalid.",
      false,
    );
  }
}

function contentLength(response: Response): number | null {
  const raw = response.headers.get("content-length");
  if (raw === null || !/^[0-9]+$/.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declaredLength = contentLength(response);
  if (declaredLength !== null && declaredLength > maximumBytes) {
    throw new TransportError(
      "TRANSPORT_MALFORMED_RESPONSE",
      "The Redrive response exceeded the size limit.",
      false,
    );
  }

  if (response.body === null || response.body === undefined) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maximumBytes) {
      throw new TransportError(
        "TRANSPORT_MALFORMED_RESPONSE",
        "The Redrive response exceeded the size limit.",
        false,
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      totalBytes += part.value.byteLength;
      if (totalBytes > maximumBytes) {
        throw new TransportError(
          "TRANSPORT_MALFORMED_RESPONSE",
          "The Redrive response exceeded the size limit.",
          false,
        );
      }
      chunks.push(part.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new TransportError(
      "TRANSPORT_MALFORMED_RESPONSE",
      "The Redrive response was not valid UTF-8 JSON.",
      false,
    );
  }
}

function isRedirectFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (/redirect/i.test(error.message)) return true;
  const cause = (error as { cause?: unknown }).cause;
  return cause instanceof Error && /redirect/i.test(cause.message);
}

function malformedResponse(message: string): TransportError {
  return new TransportError("TRANSPORT_MALFORMED_RESPONSE", message, false);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw malformedResponse("The Redrive response was not valid JSON.");
  }
}

function parseCompletionErrorCode(body: string): string | undefined {
  const value = parseJson(body);
  if (!isRecord(value)) {
    throw malformedResponse("The Redrive completion error response was incompatible.");
  }
  if (!hasOwn(value, "code")) return undefined;
  return boundedText(value.code, "completion error code", 128);
}

function parseEnrollmentResponse(value: unknown): EnrollmentResult {
  if (!isRecord(value) || !hasOwn(value, "receiverConnection")) {
    throw malformedResponse("The Redrive enrollment response was incompatible.");
  }
  if (!isRecord(value.receiverConnection)) {
    throw malformedResponse("The Redrive enrollment response was incompatible.");
  }
  const connectorId = boundedText(
    value.receiverConnection.connectorId,
    "enrollment connector identity",
    255,
  );
  if (value.disposition !== "ENROLLED" && value.disposition !== "ALREADY_ENROLLED") {
    throw malformedResponse("The Redrive enrollment response was incompatible.");
  }
  if (
    !hasOwn(value, "healthJobId") ||
    (value.healthJobId !== null &&
      (typeof value.healthJobId !== "string" ||
        value.healthJobId.trim().length === 0 ||
        value.healthJobId.length > 255 ||
        /[\u0000-\u001f\u007f]/.test(value.healthJobId)))
  ) {
    throw malformedResponse("The Redrive enrollment response was incompatible.");
  }
  return { connectorId };
}

function parseLeaseResponse(value: unknown): CapabilityJob | null {
  if (!isRecord(value) || !hasOwn(value, "job")) {
    throw malformedResponse("The Redrive lease response was incompatible.");
  }
  if (value.job === null) return null;
  try {
    return parseCapabilityJob(value.job);
  } catch (error) {
    if (error instanceof CapabilityValidationError) {
      throw malformedResponse("The Redrive lease response contained an invalid job.");
    }
    throw error;
  }
}

function parseCompletionResponse(
  value: unknown,
  expected: {
    jobId: string;
    leaseGeneration: number;
    outcome: "SUCCEEDED" | "FAILED";
  },
): void {
  if (
    !isRecord(value) ||
    !isRecord(value.job) ||
    value.job.jobId !== expected.jobId ||
    value.job.leaseGeneration !== expected.leaseGeneration ||
    value.job.state !== expected.outcome
  ) {
    throw malformedResponse("The Redrive completion response was incompatible.");
  }
}

function validateJobId(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector job identifier is invalid.",
      false,
    );
  }
}

function validateLeaseGeneration(value: unknown): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TransportError(
      "TRANSPORT_REJECTED",
      "The connector lease generation is invalid.",
      false,
    );
  }
}

function httpError(
  operation: TransportOperation,
  status: number,
  completionErrorCode?: string,
): TransportError {
  if (operation !== "enroll" && (status === 401 || status === 403)) {
    return new TransportError(
      "TRANSPORT_AUTHENTICATION",
      "Redrive rejected connector authentication.",
      false,
    );
  }
  if (
    operation === "completion" &&
    (status === 409 || status === 422) &&
    (completionErrorCode === "STALE_LEASE" ||
      completionErrorCode === "LEASE_EXPIRED" ||
      completionErrorCode === "DEADLINE_EXPIRED" ||
      completionErrorCode === "JOB_EXPIRED")
  ) {
    return new TransportError(
      "TRANSPORT_COMPLETION_FENCED",
      "Redrive rejected completion because the receiver job is no longer completable.",
      false,
    );
  }
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return new TransportError(
      "TRANSPORT_ERROR",
      "The Redrive central service returned a temporary error.",
      true,
    );
  }
  return new TransportError(
    "TRANSPORT_REJECTED",
    "The Redrive central service rejected the connector request.",
    false,
  );
}

export class ConcreteRedriveHttpTransport implements RedriveTransport {
  private readonly origin: string;
  private readonly fetchImpl: typeof fetch;
  private readonly enrollmentTimeoutMs: number;
  private readonly leaseTimeoutMs: number;
  private readonly completionTimeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: ConcreteRedriveHttpTransportOptions) {
    this.origin = normalizeOrigin(options.redriveUrl);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.enrollmentTimeoutMs = positiveBound(
      options.enrollmentTimeoutMs,
      DEFAULT_ENROLLMENT_TIMEOUT_MS,
      120_000,
      "The enrollment timeout is invalid.",
    );
    this.leaseTimeoutMs = positiveBound(
      options.leaseTimeoutMs,
      DEFAULT_LEASE_TIMEOUT_MS,
      120_000,
      "The lease timeout is invalid.",
    );
    this.completionTimeoutMs = positiveBound(
      options.completionTimeoutMs,
      DEFAULT_COMPLETION_TIMEOUT_MS,
      120_000,
      "The completion timeout is invalid.",
    );
    this.maxResponseBytes = positiveBound(
      options.maxResponseBytes,
      DEFAULT_TRANSPORT_MAX_RESPONSE_BYTES,
      4 * 1024 * 1024,
      "The Redrive response size limit is invalid.",
    );
    this.signal = options.signal;
  }

  async enroll(request: EnrollmentRequest): Promise<EnrollmentResult> {
    validateIdentity(request.identity, this.origin);
    validateCapabilities(request.capabilities);
    const response = await this.postJson(
      "enroll",
      "/api/receiver/enroll",
      {
        protocolVersion: REDRIVE_CONNECTOR_PROTOCOL_VERSION,
        enrollmentToken: request.enrollmentToken,
        connectorId: request.identity.connectorId,
        connectorSecret: request.identity.connectorSecret,
        capabilities: request.capabilities,
      },
      this.enrollmentTimeoutMs,
    );
    return parseEnrollmentResponse(response);
  }

  async lease(request: LeaseRequest): Promise<CapabilityJob | null> {
    validateIdentity(request.identity, this.origin);
    validateCapabilities(request.capabilities);
    const response = await this.post(
      "lease",
      "/api/receiver/jobs/lease",
      {
        "X-Redrive-Connector-Id": request.identity.connectorId,
        Authorization: `Bearer ${request.identity.connectorSecret}`,
      },
      this.leaseTimeoutMs,
    );
    return parseLeaseResponse(response);
  }

  async complete(request: CompleteRequest): Promise<void> {
    validateIdentity(request.identity, this.origin);
    validateJobId(request.jobId);
    validateLeaseGeneration(request.leaseGeneration);
    const result = parseCapabilityResult(
      request.capability,
      request.input,
      request.result,
    );
    const response = await this.postJson(
      "completion",
      `/api/receiver/jobs/${encodeURIComponent(request.jobId)}/complete`,
      {
        leaseGeneration: request.leaseGeneration,
        outcome: "SUCCEEDED",
        result,
      },
      this.completionTimeoutMs,
      {
        "X-Redrive-Connector-Id": request.identity.connectorId,
        Authorization: `Bearer ${request.identity.connectorSecret}`,
      },
    );
    parseCompletionResponse(response, {
      jobId: request.jobId,
      leaseGeneration: request.leaseGeneration,
      outcome: "SUCCEEDED",
    });
  }

  async fail(request: FailRequest): Promise<void> {
    validateIdentity(request.identity, this.origin);
    validateJobId(request.jobId);
    validateLeaseGeneration(request.leaseGeneration);
    if (request.error === null || typeof request.error !== "object") {
      throw new TransportError(
        "TRANSPORT_REJECTED",
        "The connector failure is invalid.",
        false,
      );
    }
    const errorCode = boundedText(request.error.code, "connector error code", 128);
    const response = await this.postJson(
      "completion",
      `/api/receiver/jobs/${encodeURIComponent(request.jobId)}/complete`,
      {
        leaseGeneration: request.leaseGeneration,
        outcome: "FAILED",
        errorCode,
      },
      this.completionTimeoutMs,
      {
        "X-Redrive-Connector-Id": request.identity.connectorId,
        Authorization: `Bearer ${request.identity.connectorSecret}`,
      },
    );
    parseCompletionResponse(response, {
      jobId: request.jobId,
      leaseGeneration: request.leaseGeneration,
      outcome: "FAILED",
    });
  }

  private async postJson(
    operation: TransportOperation,
    pathname: string,
    body: unknown,
    timeoutMs: number,
    extraHeaders: Record<string, string> = {},
  ): Promise<unknown> {
    let serialized: string;
    try {
      serialized = JSON.stringify(body);
    } catch {
      throw new TransportError(
        "TRANSPORT_REJECTED",
        "The connector request could not be encoded.",
        false,
      );
    }
    return this.post(
      operation,
      pathname,
      { "Content-Type": "application/json", ...extraHeaders },
      timeoutMs,
      serialized,
    );
  }

  private async post(
    operation: TransportOperation,
    pathname: string,
    headers: Record<string, string>,
    timeoutMs: number,
    body?: string,
  ): Promise<unknown> {
    const url = new URL(pathname, `${this.origin}/`).href;
    return this.request(operation, url, {
      method: "POST",
      headers,
      ...(body === undefined ? {} : { body }),
    }, timeoutMs);
  }

  private async request(
    operation: TransportOperation,
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.signal?.aborted) {
      throw new TransportError(
        "TRANSPORT_ERROR",
        "The Redrive request was aborted.",
        true,
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    let externallyAborted = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      externallyAborted = true;
      controller.abort();
    };
    this.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(
          new TransportError(
            "TRANSPORT_TIMEOUT",
            `The Redrive ${operation} request timed out.`,
            true,
          ),
        );
      }, timeoutMs);
    });

    try {
      const response = await Promise.race([
        this.fetchImpl(url, {
          ...init,
          redirect: "error",
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (response.redirected || (response.status >= 300 && response.status < 400)) {
        throw new TransportError(
          "TRANSPORT_REDIRECT",
          "The Redrive request returned a redirect.",
          false,
        );
      }
      if (response.status < 200 || response.status >= 300) {
        if (
          operation === "completion" &&
          (response.status === 409 || response.status === 422)
        ) {
          const body = await Promise.race([
            readBoundedBody(response, this.maxResponseBytes),
            timeoutPromise,
          ]);
          throw httpError(
            operation,
            response.status,
            parseCompletionErrorCode(body),
          );
        }
        throw httpError(operation, response.status);
      }
      const body = await Promise.race([
        readBoundedBody(response, this.maxResponseBytes),
        timeoutPromise,
      ]);
      return parseJson(body);
    } catch (error) {
      if (error instanceof TransportError) throw error;
      if (timedOut) {
        throw new TransportError(
          "TRANSPORT_TIMEOUT",
          `The Redrive ${operation} request timed out.`,
          true,
        );
      }
      if (externallyAborted) {
        throw new TransportError(
          "TRANSPORT_ERROR",
          "The Redrive request was aborted.",
          true,
        );
      }
      if (isRedirectFailure(error)) {
        throw new TransportError(
          "TRANSPORT_REDIRECT",
          "The Redrive request returned a redirect.",
          false,
        );
      }
      throw new TransportError(
        "TRANSPORT_ERROR",
        "The Redrive central service could not be reached.",
        true,
      );
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
      this.signal?.removeEventListener("abort", onAbort);
    }
  }
}
