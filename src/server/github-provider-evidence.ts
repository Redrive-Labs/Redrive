import {
  computeProviderPayloadSha256,
  GITHUB_PROVIDER,
  parseProviderEvidence,
  ProviderEvidenceValidationError,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import type { GithubWebhookDeliveryLookup } from "@/server/github-mcp";

export class GithubDeliveryNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubDeliveryNormalizationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireRecord(
  value: unknown,
  field: string,
): Record<string, unknown> {
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

function requireHeaders(
  value: unknown,
  field: string,
): Record<string, string> {
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

interface DeliveryIdentityCandidates {
  values: string[];
}

function collectDeliveryIdentityCandidates(
  record: Record<string, unknown>,
): DeliveryIdentityCandidates {
  const candidates: string[] = [];
  const fields = ["deliveryId", "delivery_id", "guid", "id"] as const;

  for (const field of fields) {
    if (!Object.prototype.hasOwnProperty.call(record, field)) {
      continue;
    }

    const value = record[field];
    if (typeof value === "string") {
      if (value.length === 0) {
        throw new GithubDeliveryNormalizationError(
          `GitHub delivery field ${field} must be a non-empty string.`,
        );
      }

      candidates.push(value);
      continue;
    }

    if (
      typeof value === "number" &&
      Number.isFinite(value) &&
      Number.isInteger(value)
    ) {
      // The proven GitHub response exposes its internal delivery id as a
      // JSON number. Convert the already-parsed integer to BigInt immediately
      // for comparison; never use String(number), which can change an opaque
      // id above Number.MAX_SAFE_INTEGER. The normalized id still comes from
      // the requested string.
      candidates.push(BigInt(value).toString());
      continue;
    }

    throw new GithubDeliveryNormalizationError(
      `GitHub delivery field ${field} must be a string identifier.`,
    );
  }

  return { values: candidates };
}

function assertMatchingDeliveryId(
  body: Record<string, unknown>,
  requestedDeliveryId: string,
): void {
  const candidates = collectDeliveryIdentityCandidates(body);

  if (candidates.values.includes(requestedDeliveryId)) {
    return;
  }

  if (candidates.values.length === 0) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response does not contain a delivery identifier.",
    );
  }

  throw new GithubDeliveryNormalizationError(
    "GitHub delivery ID does not match the incident delivery ID.",
  );
}

function addRepositoryCandidate(
  candidates: string[],
  value: unknown,
  field: string,
): void {
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new GithubDeliveryNormalizationError(
        `GitHub repository field ${field} must not be empty.`,
      );
    }

    candidates.push(value);
    return;
  }

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    Number.isFinite(value)
  ) {
    // repository_id is a numeric GitHub field in the proven response. It is
    // compared only when safe; the Redrive-owned identifier remains a string.
    candidates.push(String(value));
    return;
  }

  throw new GithubDeliveryNormalizationError(
    `GitHub repository field ${field} must be a string or safe integer.`,
  );
}

function collectRepositoryCandidates(
  body: Record<string, unknown>,
  payload: unknown,
): string[] {
  const candidates: string[] = [];

  for (const field of [
    "repositoryId",
    "repository_id",
    "repositoryFullName",
    "repository_full_name",
  ] as const) {
    if (Object.prototype.hasOwnProperty.call(body, field)) {
      addRepositoryCandidate(candidates, body[field], field);
    }
  }

  if (isRecord(payload) && Object.prototype.hasOwnProperty.call(payload, "repository")) {
    const repository = payload.repository;
    if (typeof repository === "string") {
      addRepositoryCandidate(candidates, repository, "request.payload.repository");
    } else {
      const repositoryRecord = requireRecord(
        repository,
        "request.payload.repository",
      );

      for (const field of ["full_name", "fullName", "id"] as const) {
        if (Object.prototype.hasOwnProperty.call(repositoryRecord, field)) {
          addRepositoryCandidate(
            candidates,
            repositoryRecord[field],
            `request.payload.repository.${field}`,
          );
        }
      }
    }
  }

  return candidates;
}

function assertMatchingRepositoryId(
  body: Record<string, unknown>,
  payload: unknown,
  requestedRepositoryId: string,
): void {
  const candidates = collectRepositoryCandidates(body, payload);

  if (candidates.length > 0 && !candidates.includes(requestedRepositoryId)) {
    throw new GithubDeliveryNormalizationError(
      "GitHub repository identity does not match the incident repository ID.",
    );
  }
}

function readResponseBody(
  response: Record<string, unknown>,
): string | null {
  const hasPayload = Object.prototype.hasOwnProperty.call(response, "payload");
  const hasBody = Object.prototype.hasOwnProperty.call(response, "body");

  if (!hasPayload && !hasBody) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response body is required.",
    );
  }

  if (hasPayload && hasBody && response.payload !== response.body) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery response has conflicting body fields.",
    );
  }

  const value = hasPayload ? response.payload : response.body;
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
  const response = requireRecord(body.response, "full.body.response");
  if (!Object.prototype.hasOwnProperty.call(request, "payload")) {
    throw new GithubDeliveryNormalizationError(
      "GitHub delivery request payload is required.",
    );
  }

  const payload = request.payload;
  let payloadSha256: string;
  try {
    payloadSha256 = computeProviderPayloadSha256(payload);
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
    deliveryId: lookup.deliveryId,
    event: requireNonEmptyString(body, "event"),
    deliveredAt: requireTimestamp(body, "delivered_at"),
    outcome: {
      status: requireNonEmptyString(body, "status"),
      statusCode: requireStatusCode(body, "status_code"),
    },
    request: {
      headers: requireHeaders(
        request.headers,
        "full.body.request.headers",
      ),
      payload,
      payloadSha256,
    },
    response: {
      headers: requireHeaders(
        response.headers,
        "full.body.response.headers",
      ),
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
