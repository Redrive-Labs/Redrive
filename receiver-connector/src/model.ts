export const CONNECTOR_SCHEMA_VERSION = 1 as const;

export const RECEIVER_CAPABILITY_BUSINESS_STATE = "business_state:v1" as const;
export const RECEIVER_CAPABILITY_HEALTH = "health:v1" as const;

export const RECEIVER_CAPABILITIES = Object.freeze([
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
] as const);

export type ReceiverCapability = (typeof RECEIVER_CAPABILITIES)[number];

export type ReceiverHealthStatus = "HEALTHY" | "UNHEALTHY";
export type ReceiverBusinessState = "ABSENT" | "EXACTLY_ONE" | "MULTIPLE";

export interface ConnectorIdentity {
  readonly schemaVersion: typeof CONNECTOR_SCHEMA_VERSION;
  readonly serverOrigin: string;
  readonly connectorId: string;
  readonly connectorSecret: string;
}

export interface BusinessStateInput {
  readonly deliveryGuid: string;
}

export interface HealthInput {
  // Deliberately empty. Health is bound to local configuration, not job input.
}

export interface CapabilityJobMetadata {
  readonly jobId: string;
  readonly leaseExpiresAt?: string;
  readonly deadlineAt?: string;
}

export interface BusinessStateJob extends CapabilityJobMetadata {
  readonly capability: typeof RECEIVER_CAPABILITY_BUSINESS_STATE;
  readonly leaseGeneration: number;
  readonly input: BusinessStateInput;
}

export interface HealthJob extends CapabilityJobMetadata {
  readonly capability: typeof RECEIVER_CAPABILITY_HEALTH;
  readonly leaseGeneration: number;
  readonly input: HealthInput;
}

export type CapabilityJob = BusinessStateJob | HealthJob;
export type CapabilityInput = BusinessStateInput | HealthInput;

export interface BusinessStateResult {
  readonly schemaVersion: typeof CONNECTOR_SCHEMA_VERSION;
  readonly deliveryGuid: string;
  readonly mutationCount: number;
  readonly businessState: ReceiverBusinessState;
  readonly observedAt: string;
}

export interface HealthResult {
  readonly schemaVersion: typeof CONNECTOR_SCHEMA_VERSION;
  readonly healthStatus: ReceiverHealthStatus;
  readonly observedAt: string;
}

export type CapabilityResult = BusinessStateResult | HealthResult;

export interface CapabilityError {
  readonly schemaVersion: typeof CONNECTOR_SCHEMA_VERSION;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface JobFailureReference {
  readonly jobId: string;
  readonly capability: string;
  readonly leaseGeneration: number;
}

export class CapabilityValidationError extends Error {
  readonly code: "INVALID_JOB" | "UNSUPPORTED_CAPABILITY" | "INVALID_RESULT";

  constructor(
    code: CapabilityValidationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "CapabilityValidationError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertRecord(value: unknown, field: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new CapabilityValidationError(
      "INVALID_JOB",
      `${field} must be an object.`,
    );
  }
}

function assertExactKeys(
  record: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  if (Object.keys(record).some((key) => !allowed.has(key))) {
    throw new CapabilityValidationError(
      "INVALID_JOB",
      `${field} contains an unexpected field.`,
    );
  }
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      throw new CapabilityValidationError(
        "INVALID_JOB",
        `${field}.${key} is required.`,
      );
    }
  }
  for (const key of optionalKeys) {
    if (
      Object.prototype.hasOwnProperty.call(record, key) &&
      record[key] === undefined
    ) {
      throw new CapabilityValidationError(
        "INVALID_JOB",
        `${field}.${key} cannot be undefined.`,
      );
    }
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
    throw new CapabilityValidationError(
      "INVALID_JOB",
      `${field} must be a bounded non-empty string.`,
    );
  }
  return value;
}

function readOptionalText(
  record: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(record, field)) return undefined;
  return readText(record, field, maximumLength);
}

function readLeaseGeneration(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new CapabilityValidationError(
      "INVALID_JOB",
      "leaseGeneration must be a safe non-negative integer.",
    );
  }
  return value;
}

function readTimestamp(
  record: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = readOptionalText(record, field, 128);
  if (value !== undefined && !Number.isFinite(Date.parse(value))) {
    throw new CapabilityValidationError(
      "INVALID_JOB",
      `${field} must be a valid timestamp.`,
    );
  }
  return value;
}

export function parseBusinessStateInput(value: unknown): BusinessStateInput {
  assertRecord(value, "business_state:v1 input");
  assertExactKeys(value, ["deliveryGuid"], [], "business_state:v1 input");
  return { deliveryGuid: readText(value, "deliveryGuid", 1024) };
}

export function parseHealthInput(value: unknown): HealthInput {
  assertRecord(value, "health:v1 input");
  assertExactKeys(value, [], [], "health:v1 input");
  return {};
}

export function parseCapabilityJob(value: unknown): CapabilityJob {
  assertRecord(value, "capability job");
  assertExactKeys(
    value,
    ["jobId", "capability", "leaseGeneration", "input"],
    ["leaseExpiresAt", "deadlineAt"],
    "capability job",
  );

  const capability = value.capability;
  if (
    capability !== RECEIVER_CAPABILITY_BUSINESS_STATE &&
    capability !== RECEIVER_CAPABILITY_HEALTH
  ) {
    throw new CapabilityValidationError(
      "UNSUPPORTED_CAPABILITY",
      "The capability is not supported by this connector.",
    );
  }

  const jobId = readText(value, "jobId", 255);
  const leaseExpiresAt = readTimestamp(value, "leaseExpiresAt");
  const deadlineAt = readTimestamp(value, "deadlineAt");
  const metadata = {
    jobId,
    leaseGeneration: readLeaseGeneration(value.leaseGeneration),
    ...(leaseExpiresAt === undefined
      ? {}
      : { leaseExpiresAt }),
    ...(deadlineAt === undefined ? {} : { deadlineAt }),
  };

  if (capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
    return {
      ...metadata,
      capability,
      input: parseBusinessStateInput(value.input),
    };
  }
  return {
    ...metadata,
    capability,
    input: parseHealthInput(value.input),
  };
}

function expectedBusinessState(mutationCount: number): ReceiverBusinessState {
  if (mutationCount === 0) return "ABSENT";
  if (mutationCount === 1) return "EXACTLY_ONE";
  return "MULTIPLE";
}

export function parseBusinessStateResult(
  value: unknown,
  expectedDeliveryGuid: string,
): BusinessStateResult {
  if (!isRecord(value)) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result must be an object.",
    );
  }
  assertExactKeys(
    value,
    [
      "schemaVersion",
      "deliveryGuid",
      "mutationCount",
      "businessState",
      "observedAt",
    ],
    [],
    "business_state:v1 result",
  );
  if (value.schemaVersion !== CONNECTOR_SCHEMA_VERSION) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result schemaVersion is unsupported.",
    );
  }
  const deliveryGuid = readText(value, "deliveryGuid", 1024);
  if (deliveryGuid !== expectedDeliveryGuid) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result deliveryGuid does not match the job input.",
    );
  }
  const mutationCount = value.mutationCount;
  if (
    typeof mutationCount !== "number" ||
    !Number.isSafeInteger(mutationCount) ||
    mutationCount < 0
  ) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result mutationCount must be a safe non-negative integer.",
    );
  }
  const businessState = value.businessState;
  if (
    businessState !== "ABSENT" &&
    businessState !== "EXACTLY_ONE" &&
    businessState !== "MULTIPLE"
  ) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result businessState is invalid.",
    );
  }
  if (businessState !== expectedBusinessState(mutationCount)) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result businessState does not match mutationCount.",
    );
  }
  const observedAt = readText(value, "observedAt", 128);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "business_state:v1 result observedAt must be a valid timestamp.",
    );
  }
  return {
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    deliveryGuid,
    mutationCount,
    businessState,
    observedAt,
  };
}

export function parseHealthResult(value: unknown): HealthResult {
  if (!isRecord(value)) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "health:v1 result must be an object.",
    );
  }
  assertExactKeys(
    value,
    ["schemaVersion", "healthStatus", "observedAt"],
    [],
    "health:v1 result",
  );
  if (value.schemaVersion !== CONNECTOR_SCHEMA_VERSION) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "health:v1 result schemaVersion is unsupported.",
    );
  }
  if (value.healthStatus !== "HEALTHY" && value.healthStatus !== "UNHEALTHY") {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "health:v1 result healthStatus is invalid.",
    );
  }
  const observedAt = readText(value, "observedAt", 128);
  if (!Number.isFinite(Date.parse(observedAt))) {
    throw new CapabilityValidationError(
      "INVALID_RESULT",
      "health:v1 result observedAt must be a valid timestamp.",
    );
  }
  return {
    schemaVersion: CONNECTOR_SCHEMA_VERSION,
    healthStatus: value.healthStatus,
    observedAt,
  };
}

export function parseCapabilityResult(
  capability: ReceiverCapability,
  input: CapabilityInput,
  value: unknown,
): CapabilityResult {
  if (capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
    const businessInput = parseBusinessStateInput(input);
    return parseBusinessStateResult(value, businessInput.deliveryGuid);
  }
  parseHealthInput(input);
  return parseHealthResult(value);
}

export function getJobFailureReference(value: unknown): JobFailureReference | null {
  if (!isRecord(value)) return null;
  const capability = value.capability;
  const leaseGeneration = value.leaseGeneration;
  if (
    typeof capability !== "string" ||
    capability.trim().length === 0 ||
    capability.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(capability) ||
    typeof leaseGeneration !== "number" ||
    !Number.isSafeInteger(leaseGeneration) ||
    leaseGeneration < 0
  ) {
    return null;
  }
  const jobId = value.jobId;
  if (
    typeof jobId !== "string" ||
    jobId.trim().length === 0 ||
    jobId.length > 255 ||
    /[\u0000-\u001f\u007f]/.test(jobId)
  ) {
    return null;
  }
  return {
    jobId,
    capability,
    leaseGeneration,
  };
}

export function toJobFailureReference(job: CapabilityJob): JobFailureReference {
  return {
    jobId: job.jobId,
    capability: job.capability,
    leaseGeneration: job.leaseGeneration,
  };
}
