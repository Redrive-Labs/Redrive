import {
  computeCanonicalProviderPayloadSha256,
  GITHUB_PROVIDER,
  parseProviderEvidence,
  ProviderEvidenceValidationError,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import type { GithubWebhookDeliveryLookup } from "@/server/github/github-mcp";

export class GithubDeliveryNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubDeliveryNormalizationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} must be an object.`,
    );
  }

  return value;
}

function requireNonEmptyString(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = record[field];

  if (typeof value !== "string" || value.length === 0) {
    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} must be a non-empty string.`,
    );
  }

  return value;
}

function requireTimestamp(
  record: Record<string, unknown>,
  field: string,
): string {
  const value = requireNonEmptyString(record, field);

  if (!Number.isFinite(Date.parse(value))) {
    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} must be a valid timestamp.`,
    );
  }

  return value;
}

function requireHeaders(value: unknown, field: string): Record<string, string> {
  const headersRecord = requireRecord(value, field);
  const headers: Record<string, string> = {};

  for (const [name, headerValue] of Object.entries(headersRecord)) {
    if (typeof headerValue !== "string") {
      throw new GithubDeliveryNormalizationError(
        `GitHub delivery header ${field}.${name} must be a string.`,
      );
    }

    headers[name] = headerValue;
  }

  return headers;
}

function requireStatusCode(
  record: Record<string, unknown>,
  field: string,
): number | null {
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} is required.`,
    );
  }

  const value = record[field];
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      !Number.isInteger(value))
  ) {
    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} must be an integer or null.`,
    );
  }

  return value;
}

function readProviderDeliveryId(body: Record<string, unknown>): string {
  if (!Object.prototype.hasOwnProperty.call(body, "id")) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response does not contain a delivery identifier.",
    );
  }
  const value = body.id;
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isSafeInteger(value))
    return String(value);
  throw new GithubDeliveryNormalizationError(
    "GitHub delivery field id must be a non-empty string or safe integer.",
  );
}

function assertMatchingDeliveryId(
  body: Record<string, unknown>,
  requested: string,
): void {
  if (readProviderDeliveryId(body) !== requested) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery ID does not match the incident delivery ID.",
    );
  }
}

function assertGuidHeader(
  body: Record<string, unknown>,
  request: Record<string, unknown>,
): string {
  const guid = requireNonEmptyString(body, "guid");
  const headers = requireHeaders(request.headers, "full.body.request.headers");
  const matches = Object.entries(headers).filter(
    ([name]) => name.toLowerCase() === "x-github-delivery",
  );
  if (matches.length === 0)
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery request is missing X-GitHub-Delivery header.",
    );
  const values = new Set(matches.map(([, value]) => value));
  if (values.size !== 1 || !values.has(guid))
    throw new GithubDeliveryNormalizationError(
      "X-GitHub-Delivery header does not match the delivery GUID.",
    );
  return guid;
}

function readRepositoryIdentifier(
  value: unknown,
  field: string,
): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }

  throw new GithubDeliveryNormalizationError(
    `GitHub repository field ${field} must be a non-empty string or safe integer.`,
  );
}

function assertMatchingRepositoryId(
  body: Record<string, unknown>,
  payload: unknown,
  requestedRepositoryId: string,
): void {
  if (!Object.prototype.hasOwnProperty.call(body, "repository_id")) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery field repository_id is required.",
    );
  }
  const bodyRepositoryId = readRepositoryIdentifier(
    body.repository_id,
    "repository_id",
  );
  const payloadRecord = requireRecord(payload, "request.payload");
  const repository = requireRecord(
    payloadRecord.repository,
    "request.payload.repository",
  );
  const payloadRepositoryId = readRepositoryIdentifier(
    repository.id,
    "request.payload.repository.id",
  );
  const repositoryFullName = requireNonEmptyString(repository, "full_name");

  if (
    bodyRepositoryId !== payloadRepositoryId ||
    (requestedRepositoryId !== bodyRepositoryId &&
      requestedRepositoryId !== repositoryFullName)
  ) {
    throw new GithubDeliveryNormalizationError(
      "GitHub repository identity does not match the incident repository ID.",
    );
  }
}

function readResponseBody(response: Record<string, unknown>): string | null {
  if (!Object.prototype.hasOwnProperty.call(response, "payload")) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response payload is required.",
    );
  }

  const value = response.payload;
  if (value !== null && typeof value !== "string") {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response payload must be a string or null.",
    );
  }

  return value;
}

function readDeliveryBody(result: unknown): Record<string, unknown> {
  const root = requireRecord(result, "root");
  const full = requireRecord(root.full, "full");
  if (full.http_status !== 200) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery field full.http_status must be 200.",
    );
  }
  return requireRecord(full.body, "full.body");
}

export function normalizeGithubWebhookDelivery(
  result: unknown,
  lookup: GithubWebhookDeliveryLookup,
  capturedAt = new Date().toISOString(),
): ProviderEvidence {
  if (
    typeof lookup.repositoryId !== "string" ||
    lookup.repositoryId.length === 0 ||
    typeof lookup.deliveryId !== "string" ||
    lookup.deliveryId.length === 0
  ) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery lookup identifiers must be non-empty strings.",
    );
  }

  const body = readDeliveryBody(result);
  assertMatchingDeliveryId(body, lookup.deliveryId);

  if (typeof body.redelivery !== "boolean") {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery field redelivery must be a boolean.",
    );
  }

  const request = requireRecord(body.request, "full.body.request");
  const deliveryGuid = assertGuidHeader(body, request);
  const response = requireRecord(body.response, "full.body.response");
  if (!Object.prototype.hasOwnProperty.call(request, "payload")) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery request payload is required.",
    );
  }

  const payload = request.payload;
  let canonicalPayloadSha256: string;
  try {
    canonicalPayloadSha256 = computeCanonicalProviderPayloadSha256(payload);
  } catch (error) {
    if (error instanceof ProviderEvidenceValidationError) {
      throw new GithubDeliveryNormalizationError(error.message);
    }

    throw error;
  }
  assertMatchingRepositoryId(body, payload, lookup.repositoryId);

  const evidence = {
    schemaVersion: 1 as const,
    provider: GITHUB_PROVIDER,
    repositoryId: lookup.repositoryId,
    providerDeliveryId: lookup.deliveryId,
    deliveryGuid,
    event: requireNonEmptyString(body, "event"),
    deliveredAt: requireTimestamp(body, "delivered_at"),
    outcome: {
      status: requireNonEmptyString(body, "status"),
      statusCode: requireStatusCode(body, "status_code"),
    },
    request: {
      headers: requireHeaders(request.headers, "full.body.request.headers"),
      payload,
      canonicalPayloadSha256,
    },
    response: {
      headers: requireHeaders(response.headers, "full.body.response.headers"),
      body: readResponseBody(response),
    },
    redelivery: body.redelivery,
    capturedAt,
  };

  try {
    return parseProviderEvidence(evidence);
  } catch (error) {
    if (error instanceof ProviderEvidenceValidationError) {
      throw new GithubDeliveryNormalizationError(error.message);
    }

    throw error;
  }
}
