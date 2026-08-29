export const INCIDENT_STATUS = "OPEN" as const;

export type IncidentStatus = typeof INCIDENT_STATUS;

export interface Incident {
  id: string;
  provider: string;
  externalDeliveryId: string;
  repositoryId: string;
  /** Present only for incidents created from a durable application connection. */
  applicationConnectionId?: string;
  status: IncidentStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CreateIncidentInput {
  provider: string;
  externalDeliveryId: string;
  repositoryId: string;
}

export const INCIDENT_INPUT_LIMITS = {
  provider: 128,
  externalDeliveryId: 512,
  repositoryId: 255,
} as const;

export type IncidentValidationIssues = Record<string, string>;

export class IncidentValidationError extends Error {
  readonly issues: IncidentValidationIssues;

  constructor(issues: IncidentValidationIssues) {
    super("Incident input is invalid.");
    this.name = "IncidentValidationError";
    this.issues = issues;
  }
}

function readRequiredString(
  input: Record<string, unknown>,
  field: string,
  issues: IncidentValidationIssues,
  maxLength: number,
): string {
  const value = input[field];

  if (typeof value !== "string" || value.trim().length === 0) {
    issues[field] = "Must be a non-empty string.";
    return "";
  }

  if (value.length > maxLength) {
    issues[field] = `Must be at most ${maxLength} characters.`;
  }

  return value;
}

export function parseCreateIncidentInput(
  input: unknown,
): CreateIncidentInput {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new IncidentValidationError({
      form: "Request must be a JSON object.",
    });
  }

  const record = input as Record<string, unknown>;
  const issues: IncidentValidationIssues = {};
  const provider = readRequiredString(
    record,
    "provider",
    issues,
    INCIDENT_INPUT_LIMITS.provider,
  );
  const externalDeliveryId = readRequiredString(
    record,
    "externalDeliveryId",
    issues,
    INCIDENT_INPUT_LIMITS.externalDeliveryId,
  );
  const repositoryId = readRequiredString(
    record,
    "repositoryId",
    issues,
    INCIDENT_INPUT_LIMITS.repositoryId,
  );

  // Connection-backed incidents must go through the connection-scoped route,
  // which verifies the authoritative failed delivery before persistence.
  if (Object.prototype.hasOwnProperty.call(record, "applicationConnectionId")) {
    issues.applicationConnectionId =
      "Connection-backed incidents must use the connection-scoped route.";
  }
  if (Object.prototype.hasOwnProperty.call(record, "deliveryId")) {
    issues.deliveryId =
      "Connection-backed incidents must use the connection-scoped route.";
  }

  if (Object.keys(issues).length > 0) {
    throw new IncidentValidationError(issues);
  }

  return {
    provider,
    externalDeliveryId,
    repositoryId,
  };
}
