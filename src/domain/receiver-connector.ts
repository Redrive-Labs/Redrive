import { isRecord } from "@/domain/github-integration";

export const RECEIVER_CONNECTION_WAITING_FOR_RECEIVER =
  "WAITING_FOR_RECEIVER" as const;
export const RECEIVER_CONNECTION_VERIFYING = "VERIFYING" as const;
export const RECEIVER_CONNECTION_READY = "READY" as const;
export const RECEIVER_CONNECTION_UNHEALTHY = "UNHEALTHY" as const;

export type ReceiverConnectionState =
  | typeof RECEIVER_CONNECTION_WAITING_FOR_RECEIVER
  | typeof RECEIVER_CONNECTION_VERIFYING
  | typeof RECEIVER_CONNECTION_READY
  | typeof RECEIVER_CONNECTION_UNHEALTHY;

export const RECEIVER_CAPABILITY_BUSINESS_STATE = "business_state:v1" as const;
export const RECEIVER_CAPABILITY_HEALTH = "health:v1" as const;

export const RECEIVER_CAPABILITIES = [
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
] as const;

export type ReceiverCapability = (typeof RECEIVER_CAPABILITIES)[number];

// The transport protocol is deliberately a string because it is part of the
// connector wire contract, not a database numeric counter.
export const RECEIVER_CONNECTOR_PROTOCOL_VERSION = "1" as const;
export type ReceiverConnectorProtocolVersion =
  typeof RECEIVER_CONNECTOR_PROTOCOL_VERSION;

export const RECEIVER_READ_JOB_QUEUED = "QUEUED" as const;
export const RECEIVER_READ_JOB_LEASED = "LEASED" as const;
export const RECEIVER_READ_JOB_SUCCEEDED = "SUCCEEDED" as const;
export const RECEIVER_READ_JOB_FAILED = "FAILED" as const;
export const RECEIVER_READ_JOB_EXPIRED = "EXPIRED" as const;

export const RECEIVER_READ_JOB_DEADLINE_MS = 60 * 1000;
export const RECEIVER_READ_JOB_LEASE_MS = 15 * 1000;

export type ReceiverReadJobState =
  | typeof RECEIVER_READ_JOB_QUEUED
  | typeof RECEIVER_READ_JOB_LEASED
  | typeof RECEIVER_READ_JOB_SUCCEEDED
  | typeof RECEIVER_READ_JOB_FAILED
  | typeof RECEIVER_READ_JOB_EXPIRED;

export type ReceiverHealthStatus = "HEALTHY" | "UNHEALTHY";
export type ReceiverBusinessState = "ABSENT" | "EXACTLY_ONE" | "MULTIPLE";

export interface ReceiverConnection {
  id: string;
  applicationConnectionId: string;
  state: ReceiverConnectionState;
  enrollmentExpiresAt: string | null;
  enrollmentConsumedAt: string | null;
  connectorId: string | null;
  protocolVersion: ReceiverConnectorProtocolVersion | null;
  capabilities: ReceiverCapability[] | null;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  lastHealthStatus: ReceiverHealthStatus | null;
  lastHealthAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BusinessStateReadInput {
  deliveryGuid: string;
}

export interface HealthReadInput {
  // The empty object is intentional. It prevents a health read from becoming
  // an untyped argument bag.
}

export type ReceiverReadJobInput =
  | BusinessStateReadInput
  | HealthReadInput;

export interface BusinessStateReadResult {
  schemaVersion: 1;
  deliveryGuid: string;
  mutationCount: number;
  businessState: ReceiverBusinessState;
  observedAt: string;
}

export interface HealthReadResult {
  schemaVersion: 1;
  healthStatus: ReceiverHealthStatus;
  observedAt: string;
}

export type ReceiverReadJobResult =
  | BusinessStateReadResult
  | HealthReadResult;

export interface ReceiverReadJob {
  id: string;
  receiverConnectionId: string;
  capability: ReceiverCapability;
  input: ReceiverReadJobInput;
  state: ReceiverReadJobState;
  leaseGeneration: number;
  leasedConnectorId: string | null;
  leaseExpiresAt: string | null;
  deadlineAt: string;
  result: ReceiverReadJobResult | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ParsedReceiverEnrollment {
  protocolVersion: ReceiverConnectorProtocolVersion;
  enrollmentToken: string;
  connectorId: string;
  connectorSecret: string;
  capabilities: [
    typeof RECEIVER_CAPABILITY_BUSINESS_STATE,
    typeof RECEIVER_CAPABILITY_HEALTH,
  ];
}

export class ReceiverConnectorValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverConnectorValidationError";
  }
}

function assertRecord(
  value: unknown,
  field: string,
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReceiverConnectorValidationError(
      `Receiver connector ${field} must be an object.`,
    );
  }
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new ReceiverConnectorValidationError(
      `Receiver connector ${field} contains an unexpected field.`,
    );
  }
}

function readText(
  record: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const value = record[field];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiverConnectorValidationError(
      `Receiver connector ${field} must be a bounded non-empty string.`,
    );
  }
  return value;
}

function readOpaqueIdentifier(
  record: Record<string, unknown>,
  field: string,
  maximumLength = 1024,
): string {
  return readText(record, field, maximumLength);
}

function assertValidObservedAt(value: string): void {
  if (!Number.isFinite(Date.parse(value))) {
    throw new ReceiverConnectorValidationError(
      "Receiver connector observedAt must be a valid timestamp.",
    );
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  assertAllowedKeys(record, keys, field);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new ReceiverConnectorValidationError(
        `Receiver connector ${field}.${key} is required.`,
      );
    }
  }
}

export function parseReceiverProtocolVersion(
  value: unknown,
): ReceiverConnectorProtocolVersion {
  if (value !== RECEIVER_CONNECTOR_PROTOCOL_VERSION) {
    throw new ReceiverConnectorValidationError(
      "Receiver connector protocol version is unsupported.",
    );
  }
  return RECEIVER_CONNECTOR_PROTOCOL_VERSION;
}

export function parseReceiverCapabilities(
  value: unknown,
): ParsedReceiverEnrollment["capabilities"] {
  if (
    !Array.isArray(value) ||
    value.length !== RECEIVER_CAPABILITIES.length ||
    value[0] !== RECEIVER_CAPABILITY_BUSINESS_STATE ||
    value[1] !== RECEIVER_CAPABILITY_HEALTH
  ) {
    throw new ReceiverConnectorValidationError(
      "Receiver connector capabilities must be exactly business_state:v1 and health:v1.",
    );
  }
  return [RECEIVER_CAPABILITY_BUSINESS_STATE, RECEIVER_CAPABILITY_HEALTH];
}

export function parseReceiverEnrollment(
  value: unknown,
): ParsedReceiverEnrollment {
  assertRecord(value, "enrollment");
  assertExactKeys(
    value,
    [
      "protocolVersion",
      "enrollmentToken",
      "connectorId",
      "connectorSecret",
      "capabilities",
    ],
    "enrollment",
  );

  return {
    protocolVersion: parseReceiverProtocolVersion(value.protocolVersion),
    enrollmentToken: readText(value, "enrollmentToken", 4096),
    connectorId: readOpaqueIdentifier(value, "connectorId", 255),
    connectorSecret: readText(value, "connectorSecret", 4096),
    capabilities: parseReceiverCapabilities(value.capabilities),
  };
}

export function parseBusinessStateReadInput(
  value: unknown,
): BusinessStateReadInput {
  assertRecord(value, "business_state:v1 input");
  assertExactKeys(value, ["deliveryGuid"], "business_state:v1 input");
  return {
    deliveryGuid: readOpaqueIdentifier(value, "deliveryGuid"),
  };
}

export function parseHealthReadInput(value: unknown): HealthReadInput {
  assertRecord(value, "health:v1 input");
  assertExactKeys(value, [], "health:v1 input");
  return {};
}

export function parseReceiverReadInput(
  capability: unknown,
  value: unknown,
): ReceiverReadJobInput {
  if (capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
    return parseBusinessStateReadInput(value);
  }
  if (capability === RECEIVER_CAPABILITY_HEALTH) {
    return parseHealthReadInput(value);
  }
  throw new ReceiverConnectorValidationError(
    "Receiver connector capability is unsupported.",
  );
}

function expectedBusinessState(mutationCount: number): ReceiverBusinessState {
  if (mutationCount === 0) return "ABSENT";
  if (mutationCount === 1) return "EXACTLY_ONE";
  return "MULTIPLE";
}

export function parseBusinessStateReadResult(
  value: unknown,
  expectedDeliveryGuid: string,
): BusinessStateReadResult {
  assertRecord(value, "business_state:v1 result");
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "deliveryGuid",
      "mutationCount",
      "businessState",
      "observedAt",
    ],
    "business_state:v1 result",
  );
  if (value.schemaVersion !== 1) {
    throw new ReceiverConnectorValidationError(
      "business_state:v1 result schemaVersion is unsupported.",
    );
  }
  const deliveryGuid = readOpaqueIdentifier(value, "deliveryGuid");
  if (deliveryGuid !== expectedDeliveryGuid) {
    throw new ReceiverConnectorValidationError(
      "business_state:v1 result deliveryGuid does not match the job input.",
    );
  }
  const mutationCount = value.mutationCount;
  if (
    typeof mutationCount !== "number" ||
    !Number.isSafeInteger(mutationCount) ||
    mutationCount < 0
  ) {
    throw new ReceiverConnectorValidationError(
      "business_state:v1 result mutationCount must be a safe non-negative integer.",
    );
  }
  const businessState = value.businessState;
  if (
    businessState !== "ABSENT" &&
    businessState !== "EXACTLY_ONE" &&
    businessState !== "MULTIPLE"
  ) {
    throw new ReceiverConnectorValidationError(
      "business_state:v1 result businessState is invalid.",
    );
  }
  if (businessState !== expectedBusinessState(mutationCount)) {
    throw new ReceiverConnectorValidationError(
      "business_state:v1 result businessState does not match mutationCount.",
    );
  }
  const observedAt = readText(value, "observedAt", 128);
  assertValidObservedAt(observedAt);
  return {
    schemaVersion: 1,
    deliveryGuid,
    mutationCount,
    businessState,
    observedAt,
  };
}

export function parseHealthReadResult(value: unknown): HealthReadResult {
  assertRecord(value, "health:v1 result");
  assertExactKeys(
    value,
    ["schemaVersion", "healthStatus", "observedAt"],
    "health:v1 result",
  );
  if (value.schemaVersion !== 1) {
    throw new ReceiverConnectorValidationError(
      "health:v1 result schemaVersion is unsupported.",
    );
  }
  const healthStatus = value.healthStatus;
  if (healthStatus !== "HEALTHY" && healthStatus !== "UNHEALTHY") {
    throw new ReceiverConnectorValidationError(
      "health:v1 result healthStatus is invalid.",
    );
  }
  const observedAt = readText(value, "observedAt", 128);
  assertValidObservedAt(observedAt);
  return { schemaVersion: 1, healthStatus, observedAt };
}
