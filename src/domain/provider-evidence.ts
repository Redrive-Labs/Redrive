import { createHash } from "node:crypto";

export const PROVIDER_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const GITHUB_PROVIDER = "github" as const;

export interface ProviderEvidence {
  schemaVersion: typeof PROVIDER_EVIDENCE_SCHEMA_VERSION;
  provider: typeof GITHUB_PROVIDER;
  repositoryId: string;
  /** Exact GitHub delivery attempt ID (`id`); matches Incident.externalDeliveryId. */
  providerDeliveryId: string;
  /** Logical webhook identity (`guid` / X-GitHub-Delivery) used for idempotency. */
  deliveryGuid: string;
  event: string;
  deliveredAt: string;
  outcome: {
    status: string;
    statusCode: number | null;
  };
  request: {
    headers: Record<string, string>;
    payload: unknown;
    /**
     * SHA-256 of Redrive canonical JSON for the provider-returned payload.
     * This is not a hash of the original webhook request-body bytes.
     */
    canonicalPayloadSha256: string;
  };
  response: {
    headers: Record<string, string>;
    body: string | null;
  };
  redelivery: boolean;
  capturedAt: string;
}

export class ProviderEvidenceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderEvidenceValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ProviderEvidenceValidationError(
      `Provider evidence ${field} must be an object.`,
    );
  }
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);

  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw new ProviderEvidenceValidationError(
        `Provider evidence ${field} contains an unexpected field.`,
      );
    }
  }
}

function readNonEmptyString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderEvidenceValidationError(
      `Provider evidence ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function readHeaders(value: unknown, field: string): Record<string, string> {
  assertRecord(value, field);
  const headers: Record<string, string> = {};

  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new ProviderEvidenceValidationError(
        `Provider evidence ${field}.${name} must be a string.`,
      );
    }

    headers[name] = headerValue;
  }

  return headers;
}

function assertDeliveryGuidMatchesHeaders(
  deliveryGuid: string,
  headers: Record<string, string>,
): void {
  const values = Object.entries(headers)
    .filter(([name]) => name.toLowerCase() === "x-github-delivery")
    .map(([, value]) => value);

  if (
    values.length === 0 ||
    new Set(values).size !== 1 ||
    values[0] !== deliveryGuid
  ) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence deliveryGuid must match X-GitHub-Delivery.",
    );
  }
}

function assertJsonValue(value: unknown, field: string): void {
  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "string":
    case "boolean":
      return;
    case "number":
      if (Number.isFinite(value)) {
        return;
      }
      break;
    case "object":
      if (Array.isArray(value)) {
        for (const item of value) {
          assertJsonValue(item, field);
        }
        return;
      }

      if (isRecord(value)) {
        for (const [key, item] of Object.entries(value)) {
          assertJsonValue(item, `${field}.${key}`);
        }
        return;
      }
      break;
    default:
      break;
  }

  throw new ProviderEvidenceValidationError(
    `Provider evidence ${field} must be JSON-compatible.`,
  );
}

/**
 * Hash the provider-returned payload using Redrive canonical JSON, not the
 * original request bytes. Objects are key-sorted recursively so equivalent
 * captured JSON has one hash. Strings use their JSON-quoted representation.
 */
export function canonicalizeProviderPayload(payload: unknown): string {
  function canonicalize(value: unknown, field: string): string {
    assertJsonValue(value, field);

    if (value === null) {
      return "null";
    }

    if (typeof value === "string") {
      return JSON.stringify(value);
    }

    if (typeof value === "boolean") {
      return value ? "true" : "false";
    }

    if (typeof value === "number") {
      return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
      return `[${value
        .map((item, index) => canonicalize(item, `${field}[${index}]`))
        .join(",")}]`;
    }

    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalize(item, `${field}.${key}`)}`,
      );

    return `{${entries.join(",")}}`;
  }

  return canonicalize(payload, "request.payload");
}

export function computeCanonicalProviderPayloadSha256(
  payload: unknown,
): string {
  return createHash("sha256")
    .update(canonicalizeProviderPayload(payload), "utf8")
    .digest("hex");
}

export function parseProviderEvidence(input: unknown): ProviderEvidence {
  assertRecord(input, "root");
  assertAllowedKeys(
    input,
    [
      "schemaVersion",
      "provider",
      "repositoryId",
      "providerDeliveryId",
      "deliveryGuid",
      "event",
      "deliveredAt",
      "outcome",
      "request",
      "response",
      "redelivery",
      "capturedAt",
    ],
    "root",
  );

  if (
    input.schemaVersion !== PROVIDER_EVIDENCE_SCHEMA_VERSION ||
    input.provider !== GITHUB_PROVIDER
  ) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence has an unsupported schema version or provider.",
    );
  }

  const repositoryId = readNonEmptyString(input, "repositoryId");
  const providerDeliveryId = readNonEmptyString(input, "providerDeliveryId");
  const deliveryGuid = readNonEmptyString(input, "deliveryGuid");
  const event = readNonEmptyString(input, "event");
  const deliveredAt = readNonEmptyString(input, "deliveredAt");
  const capturedAt = readNonEmptyString(input, "capturedAt");

  assertRecord(input.outcome, "outcome");
  assertAllowedKeys(input.outcome, ["status", "statusCode"], "outcome");
  const status = readNonEmptyString(input.outcome, "status");
  const statusCode = input.outcome.statusCode;

  if (
    statusCode !== null &&
    (typeof statusCode !== "number" ||
      !Number.isFinite(statusCode) ||
      !Number.isInteger(statusCode))
  ) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence outcome.statusCode must be an integer or null.",
    );
  }

  assertRecord(input.request, "request");
  assertAllowedKeys(
    input.request,
    ["headers", "payload", "canonicalPayloadSha256"],
    "request",
  );
  const headers = readHeaders(input.request.headers, "request.headers");
  assertDeliveryGuidMatchesHeaders(deliveryGuid, headers);
  if (!Object.prototype.hasOwnProperty.call(input.request, "payload")) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence request.payload is required.",
    );
  }
  const payload = input.request.payload;
  assertJsonValue(payload, "request.payload");
  const canonicalPayloadSha256 = readNonEmptyString(
    input.request,
    "canonicalPayloadSha256",
  );

  if (!/^[a-f0-9]{64}$/.test(canonicalPayloadSha256)) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence request.canonicalPayloadSha256 is invalid.",
    );
  }

  if (
    computeCanonicalProviderPayloadSha256(payload) !== canonicalPayloadSha256
  ) {
    throw new ProviderEvidenceValidationError(
      "Provider evidence request.canonicalPayloadSha256 does not match the payload.",
    );
  }

  assertRecord(input.response, "response");
  assertAllowedKeys(input.response, ["headers", "body"], "response");
  const responseHeaders = readHeaders(
    input.response.headers,
    "response.headers",
  );
  const responseBody = input.response.body;

  if (responseBody !== null && typeof responseBody !== "string") {
    throw new ProviderEvidenceValidationError(
      "Provider evidence response.body must be a string or null.",
    );
  }

  if (typeof input.redelivery !== "boolean") {
    throw new ProviderEvidenceValidationError(
      "Provider evidence redelivery must be a boolean.",
    );
  }

  return {
    schemaVersion: PROVIDER_EVIDENCE_SCHEMA_VERSION,
    provider: GITHUB_PROVIDER,
    repositoryId,
    providerDeliveryId,
    deliveryGuid,
    event,
    deliveredAt,
    outcome: {
      status,
      statusCode,
    },
    request: {
      headers,
      payload,
      canonicalPayloadSha256,
    },
    response: {
      headers: responseHeaders,
      body: responseBody,
    },
    redelivery: input.redelivery,
    capturedAt,
  };
}
