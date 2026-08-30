import { Buffer } from "node:buffer";

export const RECOVERY_RESULT_SCHEMA_VERSION = "redrive.recovery.v1" as const;
export const RECOVERY_RESULT_VERIFIED = "REPAIR_VERIFIED" as const;
export const RECOVERY_PATCH_MAX_BYTES = 512 * 1024;

export interface RecoveryResultExpectedIdentity {
  sourceRepositoryFullName: string;
  originalRevision: string;
  deliveryGuid: string;
  providerStatusCode: number;
  receiverMutationCount: number;
}

export interface RecoveryResultArtifact {
  schemaVersion: typeof RECOVERY_RESULT_SCHEMA_VERSION;
  result: typeof RECOVERY_RESULT_VERIFIED;
  sourceRepositoryFullName: string;
  originalRevision: string;
  deliveryGuid: string;
  reproduction: {
    preCount: 0;
    httpStatus: 500;
    postCount: 1;
  };
  verification: {
    preCount: 1;
    httpStatus: number;
    postCount: 1;
  };
  changedFiles: string[];
  patch: string;
  validation: {
    testsPassed: true;
    typecheckPassed: true;
    buildPassed: true;
    diffCheckPassed: true;
  };
  notes: {
    postgresVersion: string;
  };
}

export class RecoveryResultValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RecoveryResultValidationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  field: string,
): void {
  const expectedKeys = new Set(expected);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key) => !expectedKeys.has(key)) ||
    expected.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new RecoveryResultValidationError(
      `${field} contains unexpected or missing fields.`,
    );
  }
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new RecoveryResultValidationError(
      `${field} must be a bounded non-empty string.`,
    );
  }
  return value;
}

function requirePatch(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    /[\u0000\u007f]/.test(value)
  ) {
    throw new RecoveryResultValidationError(
      "patch must be a bounded non-empty string.",
    );
  }
  return value;
}

function requireSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new RecoveryResultValidationError(
      `${field} must be a safe integer.`,
    );
  }
  return value as number;
}

function requireStatusCode(value: unknown, field: string): number {
  const status = requireSafeInteger(value, field);
  if (status < 100 || status > 599) {
    throw new RecoveryResultValidationError(
      `${field} must be an HTTP status code.`,
    );
  }
  return status;
}

function requireBooleanTrue(value: unknown, field: string): true {
  if (value !== true) {
    throw new RecoveryResultValidationError(`${field} must be true.`);
  }
  return true;
}

function requireCount(value: unknown, field: string, expected: number): void {
  if (requireSafeInteger(value, field) !== expected) {
    throw new RecoveryResultValidationError(
      `${field} must equal ${expected}.`,
    );
  }
}

function parseArtifact(
  input: unknown,
  expected: RecoveryResultExpectedIdentity,
): RecoveryResultArtifact {
  if (!isRecord(input)) {
    throw new RecoveryResultValidationError("Recovery result must be an object.");
  }
  requireExactKeys(
    input,
    [
      "schemaVersion",
      "result",
      "sourceRepositoryFullName",
      "originalRevision",
      "deliveryGuid",
      "reproduction",
      "verification",
      "changedFiles",
      "patch",
      "validation",
      "notes",
    ],
    "Recovery result",
  );

  if (input.schemaVersion !== RECOVERY_RESULT_SCHEMA_VERSION) {
    throw new RecoveryResultValidationError(
      "Recovery result schemaVersion is unsupported.",
    );
  }
  if (input.result !== RECOVERY_RESULT_VERIFIED) {
    throw new RecoveryResultValidationError(
      "Recovery result is not REPAIR_VERIFIED.",
    );
  }

  const sourceRepositoryFullName = requireNonEmptyString(
    input.sourceRepositoryFullName,
    "sourceRepositoryFullName",
  );
  const originalRevision = requireNonEmptyString(
    input.originalRevision,
    "originalRevision",
  );
  const deliveryGuid = requireNonEmptyString(
    input.deliveryGuid,
    "deliveryGuid",
  );
  if (sourceRepositoryFullName !== expected.sourceRepositoryFullName) {
    throw new RecoveryResultValidationError(
      "Recovery result repository identity does not match the incident.",
    );
  }
  if (originalRevision !== expected.originalRevision) {
    throw new RecoveryResultValidationError(
      "Recovery result revision does not match the incident.",
    );
  }
  if (deliveryGuid !== expected.deliveryGuid) {
    throw new RecoveryResultValidationError(
      "Recovery result delivery GUID does not match the incident.",
    );
  }
  if (expected.providerStatusCode !== 500) {
    throw new RecoveryResultValidationError(
      "Recovery result context is not the supported HTTP 500 contradiction.",
    );
  }
  if (expected.receiverMutationCount !== 1) {
    throw new RecoveryResultValidationError(
      "Recovery result context does not contain the required receiver mutation count.",
    );
  }

  if (!isRecord(input.reproduction)) {
    throw new RecoveryResultValidationError(
      "Recovery result reproduction must be an object.",
    );
  }
  requireExactKeys(
    input.reproduction,
    ["preCount", "httpStatus", "postCount"],
    "Recovery result reproduction",
  );
  requireCount(input.reproduction.preCount, "reproduction.preCount", 0);
  requireCount(input.reproduction.httpStatus, "reproduction.httpStatus", 500);
  requireCount(input.reproduction.postCount, "reproduction.postCount", 1);

  if (!isRecord(input.verification)) {
    throw new RecoveryResultValidationError(
      "Recovery result verification must be an object.",
    );
  }
  requireExactKeys(
    input.verification,
    ["preCount", "httpStatus", "postCount"],
    "Recovery result verification",
  );
  requireCount(input.verification.preCount, "verification.preCount", 1);
  const verificationHttpStatus = requireStatusCode(
    input.verification.httpStatus,
    "verification.httpStatus",
  );
  if (verificationHttpStatus < 200 || verificationHttpStatus >= 300) {
    throw new RecoveryResultValidationError(
      "verification.httpStatus must be a 2xx status.",
    );
  }
  requireCount(input.verification.postCount, "verification.postCount", 1);

  if (!Array.isArray(input.changedFiles) || input.changedFiles.length === 0) {
    throw new RecoveryResultValidationError(
      "Recovery result changedFiles must be non-empty.",
    );
  }
  const changedFiles = input.changedFiles.map((value, index) =>
    requireNonEmptyString(value, `changedFiles[${index}]`),
  );
  if (new Set(changedFiles).size !== changedFiles.length) {
    throw new RecoveryResultValidationError(
      "Recovery result changedFiles must not contain duplicates.",
    );
  }

  const patch = requirePatch(input.patch);
  if (Buffer.byteLength(patch, "utf8") > RECOVERY_PATCH_MAX_BYTES) {
    throw new RecoveryResultValidationError(
      `Recovery result patch exceeds ${RECOVERY_PATCH_MAX_BYTES} bytes.`,
    );
  }

  if (!isRecord(input.validation)) {
    throw new RecoveryResultValidationError(
      "Recovery result validation must be an object.",
    );
  }
  requireExactKeys(
    input.validation,
    ["testsPassed", "typecheckPassed", "buildPassed", "diffCheckPassed"],
    "Recovery result validation",
  );
  const testsPassed = requireBooleanTrue(
    input.validation.testsPassed,
    "validation.testsPassed",
  );
  const typecheckPassed = requireBooleanTrue(
    input.validation.typecheckPassed,
    "validation.typecheckPassed",
  );
  const buildPassed = requireBooleanTrue(
    input.validation.buildPassed,
    "validation.buildPassed",
  );
  const diffCheckPassed = requireBooleanTrue(
    input.validation.diffCheckPassed,
    "validation.diffCheckPassed",
  );

  if (!isRecord(input.notes)) {
    throw new RecoveryResultValidationError(
      "Recovery result notes must be an object.",
    );
  }
  requireExactKeys(input.notes, ["postgresVersion"], "Recovery result notes");
  const postgresVersion = requireNonEmptyString(
    input.notes.postgresVersion,
    "notes.postgresVersion",
  );

  return {
    schemaVersion: RECOVERY_RESULT_SCHEMA_VERSION,
    result: RECOVERY_RESULT_VERIFIED,
    sourceRepositoryFullName,
    originalRevision,
    deliveryGuid,
    reproduction: { preCount: 0, httpStatus: 500, postCount: 1 },
    verification: {
      preCount: 1,
      httpStatus: verificationHttpStatus,
      postCount: 1,
    },
    changedFiles,
    patch,
    validation: {
      testsPassed,
      typecheckPassed,
      buildPassed,
      diffCheckPassed,
    },
    notes: { postgresVersion },
  };
}

export function parseRecoveryResultJson(
  text: string,
  expected: RecoveryResultExpectedIdentity,
): RecoveryResultArtifact {
  if (typeof text !== "string" || text.trim().length === 0) {
    throw new RecoveryResultValidationError(
      "TrueForge recovery result must be a non-empty JSON document.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new RecoveryResultValidationError(
      "TrueForge recovery result is not valid JSON.",
      { cause: error },
    );
  }

  return parseArtifact(parsed, expected);
}
