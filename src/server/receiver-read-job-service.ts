import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@/server/database";
import {
  ReceiverConnectorAuthenticationError,
  isAuthenticatedReceiverConnector,
  type AuthenticatedReceiverConnector,
} from "@/server/receiver-connection-service";
import {
  parseBusinessStateReadInput,
  parseBusinessStateReadResult,
  parseHealthReadInput,
  parseHealthReadResult,
  parseReceiverReadInput,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_UNHEALTHY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
  RECEIVER_READ_JOB_DEADLINE_MS,
  RECEIVER_READ_JOB_EXPIRED,
  RECEIVER_READ_JOB_FAILED,
  RECEIVER_READ_JOB_LEASED,
  RECEIVER_READ_JOB_LEASE_MS,
  RECEIVER_READ_JOB_QUEUED,
  RECEIVER_READ_JOB_SUCCEEDED,
  type ReceiverConnectionState,
  type ReceiverHealthStatus,
  type ReceiverReadJob,
  type ReceiverReadJobInput,
  type ReceiverReadJobResult,
  type ReceiverReadJobState,
  type ReceiverCapability,
} from "@/domain/receiver-connector";
import { ReceiverConnectorValidationError } from "@/domain/receiver-connector";

export type ReceiverReadJobErrorCode =
  | "INVALID_INPUT"
  | "JOB_NOT_FOUND"
  | "JOB_ALREADY_COMPLETED"
  | "JOB_NOT_LEASED"
  | "JOB_ALREADY_LEASED"
  | "JOB_NOT_AVAILABLE"
  | "STALE_LEASE"
  | "LEASE_EXPIRED"
  | "DEADLINE_EXPIRED"
  | "JOB_EXPIRED"
  | "INVALID_STATE";

export class ReceiverReadJobError extends Error {
  readonly code: ReceiverReadJobErrorCode;

  constructor(code: ReceiverReadJobErrorCode, message: string) {
    super(message);
    this.name = "ReceiverReadJobError";
    this.code = code;
  }
}

export interface CreateReceiverReadJobInput {
  receiverConnectionId: string;
  capability: unknown;
  input: unknown;
}

interface ReceiverReadJobRow extends Record<string, unknown> {
  id: unknown;
  receiverConnectionId: unknown;
  capability: unknown;
  inputJson: unknown;
  state: unknown;
  leaseGeneration: unknown;
  leasedConnectorId: unknown;
  leaseExpiresAt: unknown;
  deadlineAt: unknown;
  resultJson: unknown;
  errorCode: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt: unknown;
}

const receiverReadJobColumns = `
  id,
  receiver_connection_id AS receiverConnectionId,
  capability,
  input_json AS inputJson,
  state,
  lease_generation AS leaseGeneration,
  leased_connector_id AS leasedConnectorId,
  lease_expires_at AS leaseExpiresAt,
  deadline_at AS deadlineAt,
  result_json AS resultJson,
  error_code AS errorCode,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Receiver read job row has an invalid ${field} value.`);
  }
  return value;
}

function readNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Receiver read job row has an invalid ${field} value.`);
  }
  return value;
}

function readJobState(row: Record<string, unknown>): ReceiverReadJobState {
  const state = readText(row, "state");
  if (
    state !== RECEIVER_READ_JOB_QUEUED &&
    state !== RECEIVER_READ_JOB_LEASED &&
    state !== RECEIVER_READ_JOB_SUCCEEDED &&
    state !== RECEIVER_READ_JOB_FAILED &&
    state !== RECEIVER_READ_JOB_EXPIRED
  ) {
    throw new Error("Receiver read job row has an invalid state.");
  }
  return state;
}

function readCapability(row: Record<string, unknown>): ReceiverCapability {
  const capability = readText(row, "capability");
  if (
    capability !== RECEIVER_CAPABILITY_BUSINESS_STATE &&
    capability !== RECEIVER_CAPABILITY_HEALTH
  ) {
    throw new Error("Receiver read job row has an invalid capability.");
  }
  return capability;
}

function parseStoredJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`Receiver read job row contains invalid ${field} JSON.`);
  }
}

function readStoredInput(
  row: Record<string, unknown>,
  capability: ReceiverCapability,
): ReceiverReadJobInput {
  const inputJson = readText(row, "inputJson");
  const parsed = parseStoredJson(inputJson, "input");
  return parseReceiverReadInput(capability, parsed);
}

function readStoredResult(
  row: Record<string, unknown>,
  capability: ReceiverCapability,
  input: ReceiverReadJobInput,
): ReceiverReadJobResult | null {
  const resultJson = readNullableText(row, "resultJson");
  if (resultJson === null) return null;
  const parsed = parseStoredJson(resultJson, "result");
  if (capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
    const businessInput = parseBusinessStateReadInput(input);
    return parseBusinessStateReadResult(parsed, businessInput.deliveryGuid);
  }
  return parseHealthReadResult(parsed);
}

function readLeaseGeneration(row: Record<string, unknown>): number {
  const value = row.leaseGeneration;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error("Receiver read job row has an invalid lease generation.");
  }
  return value;
}

function mapReceiverReadJob(row: ReceiverReadJobRow): ReceiverReadJob {
  const capability = readCapability(row);
  const input = readStoredInput(row, capability);
  const result = readStoredResult(row, capability, input);
  return {
    id: readText(row, "id"),
    receiverConnectionId: readText(row, "receiverConnectionId"),
    capability,
    input,
    state: readJobState(row),
    leaseGeneration: readLeaseGeneration(row),
    leasedConnectorId: readNullableText(row, "leasedConnectorId"),
    leaseExpiresAt: readNullableText(row, "leaseExpiresAt"),
    deadlineAt: readText(row, "deadlineAt"),
    result,
    errorCode: readNullableText(row, "errorCode"),
    createdAt: readText(row, "createdAt"),
    updatedAt: readText(row, "updatedAt"),
    completedAt: readNullableText(row, "completedAt"),
  };
}

function getReceiverReadJobRow(
  database: SqliteDatabase,
  jobId: string,
): ReceiverReadJobRow | undefined {
  return database.get<ReceiverReadJobRow>(
    `SELECT ${receiverReadJobColumns}
       FROM receiver_read_jobs
      WHERE id = ?`,
    [jobId],
  );
}

function getReceiverReadJobOrThrow(
  database: SqliteDatabase,
  jobId: string,
): ReceiverReadJob {
  const row = getReceiverReadJobRow(database, jobId);
  if (row === undefined) {
    throw new ReceiverReadJobError(
      "JOB_NOT_FOUND",
      "The receiver read job was not found.",
    );
  }
  return mapReceiverReadJob(row);
}

function readIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      `The receiver read job ${field} is invalid.`,
    );
  }
  return value;
}

type ReceiverJobClock = () => Date | string;

function readClockValue(clock: ReceiverJobClock, explicit?: Date): Date {
  const value = explicit ?? clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      "A valid clock value is required.",
    );
  }
  return new Date(date.getTime());
}

function readAuthentication(
  value: unknown,
): { receiverConnectionId: string; connectorId: string } {
  if (
    !isAuthenticatedReceiverConnector(value) ||
    typeof value.receiverConnectionId !== "string" ||
    value.receiverConnectionId.length === 0 ||
    typeof value.connectorId !== "string" ||
    value.connectorId.length === 0
  ) {
    throw new ReceiverConnectorAuthenticationError();
  }
  return {
    receiverConnectionId: value.receiverConnectionId,
    connectorId: value.connectorId,
  };
}

function assertAuthenticatedReceiver(
  database: SqliteDatabase,
  authentication: unknown,
  expectedReceiverConnectionId: string,
): { receiverConnectionId: string; connectorId: string } {
  const normalized = readAuthentication(authentication);
  if (normalized.receiverConnectionId !== expectedReceiverConnectionId) {
    throw new ReceiverConnectorAuthenticationError();
  }
  const row = database.get<{ id: string; connectorId: string }>(
    `SELECT id, connector_id AS connectorId
       FROM receiver_connections
      WHERE id = ? AND connector_id = ?`,
    [normalized.receiverConnectionId, normalized.connectorId],
  );
  if (row === undefined || row.id !== normalized.receiverConnectionId) {
    throw new ReceiverConnectorAuthenticationError();
  }
  return normalized;
}

function readReceiverState(value: unknown): ReceiverConnectionState {
  if (
    value !== RECEIVER_CONNECTION_WAITING_FOR_RECEIVER &&
    value !== RECEIVER_CONNECTION_VERIFYING &&
    value !== RECEIVER_CONNECTION_READY &&
    value !== RECEIVER_CONNECTION_UNHEALTHY
  ) {
    throw new ReceiverReadJobError(
      "INVALID_STATE",
      "The receiver connection state is invalid.",
    );
  }
  return value;
}

function nextHealthState(
  state: ReceiverConnectionState,
  healthStatus: ReceiverHealthStatus,
): ReceiverConnectionState {
  if (state === RECEIVER_CONNECTION_WAITING_FOR_RECEIVER) {
    throw new ReceiverReadJobError(
      "INVALID_STATE",
      "A waiting receiver connection cannot accept a health result.",
    );
  }
  if (healthStatus === "HEALTHY") {
    return RECEIVER_CONNECTION_READY;
  }
  return RECEIVER_CONNECTION_UNHEALTHY;
}

function readDueDate(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new ReceiverReadJobError(
      "INVALID_STATE",
      `The receiver read job ${field} is invalid.`,
    );
  }
  return parsed;
}

function markJobExpired(
  database: SqliteDatabase,
  jobId: string,
  receiverConnectionId: string,
  timestamp: string,
): void {
  const update = database.run(
    `
      UPDATE receiver_read_jobs
         SET state = ?,
             leased_connector_id = NULL,
             lease_expires_at = NULL,
             error_code = ?,
             completed_at = COALESCE(completed_at, ?),
             updated_at = ?
       WHERE id = ? AND receiver_connection_id = ?
         AND state IN (?, ?)
    `,
    [
      RECEIVER_READ_JOB_EXPIRED,
      "JOB_DEADLINE_EXPIRED",
      timestamp,
      timestamp,
      jobId,
      receiverConnectionId,
      RECEIVER_READ_JOB_QUEUED,
      RECEIVER_READ_JOB_LEASED,
    ],
  );
  if (update.changes !== 1) {
    throw new ReceiverReadJobError(
      "JOB_NOT_AVAILABLE",
      "The receiver read job is no longer available.",
    );
  }
}

function parseLeaseGeneration(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      "The receiver read job lease generation is invalid.",
    );
  }
  return value;
}

function parseFailureCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[A-Z][A-Z0-9_]{0,63}$/.test(value)
  ) {
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      "The receiver read job error code is invalid.",
    );
  }
  return value;
}

function assertTerminalState(state: ReceiverReadJobState): void {
  if (
    state === RECEIVER_READ_JOB_SUCCEEDED ||
    state === RECEIVER_READ_JOB_FAILED ||
    state === RECEIVER_READ_JOB_EXPIRED
  ) {
    throw new ReceiverReadJobError(
      "JOB_ALREADY_COMPLETED",
      "The receiver read job is already terminal.",
    );
  }
}

function assertSerializedJson(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new ReceiverConnectorValidationError(
      `Receiver connector ${field} could not be serialized.`,
    );
  }
  return serialized;
}

export interface ReceiverReadJobServiceOptions {
  database: SqliteDatabase;
  clock?: ReceiverJobClock;
  /** Alias retained for service callers that name the dependency `now`. */
  now?: ReceiverJobClock;
}

function normalizeServiceOptions(
  optionsOrDatabase: ReceiverReadJobServiceOptions | SqliteDatabase,
  clock?: ReceiverJobClock,
): ReceiverReadJobServiceOptions {
  if ("database" in optionsOrDatabase) return optionsOrDatabase;
  return { database: optionsOrDatabase, clock };
}


function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readReceiverConnectionIdFromInput(
  value: unknown,
): string {
  return readIdentifier(value, "receiverConnectionId");
}

function readCapabilityInput(
  capability: unknown,
  input: unknown,
): { capability: ReceiverCapability; input: ReceiverReadJobInput } {
  if (
    capability !== RECEIVER_CAPABILITY_BUSINESS_STATE &&
    capability !== RECEIVER_CAPABILITY_HEALTH
  ) {
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      "The receiver read job capability is unsupported.",
    );
  }
  try {
    return {
      capability,
      input: parseReceiverReadInput(capability, input),
    };
  } catch (error) {
    if (error instanceof ReceiverConnectorValidationError) throw error;
    throw new ReceiverReadJobError(
      "INVALID_INPUT",
      "The receiver read job input is invalid.",
    );
  }
}

function readCreateArguments(
  inputOrReceiverConnectionId: CreateReceiverReadJobInput | unknown,
  capabilityOrNow: unknown,
  inputOrNow: unknown,
  explicitNow: Date | undefined,
): {
  receiverConnectionId: string;
  capability: ReceiverCapability;
  input: ReceiverReadJobInput;
  now: Date | undefined;
} {
  if (isObject(inputOrReceiverConnectionId) &&
      Object.prototype.hasOwnProperty.call(inputOrReceiverConnectionId, "receiverConnectionId")) {
    const parsed = readCapabilityInput(
      inputOrReceiverConnectionId.capability,
      inputOrReceiverConnectionId.input,
    );
    return {
      receiverConnectionId: readReceiverConnectionIdFromInput(
        inputOrReceiverConnectionId.receiverConnectionId,
      ),
      ...parsed,
      now: capabilityOrNow instanceof Date ? capabilityOrNow : undefined,
    };
  }
  const parsed = readCapabilityInput(capabilityOrNow, inputOrNow);
  return {
    receiverConnectionId: readReceiverConnectionIdFromInput(
      inputOrReceiverConnectionId,
    ),
    ...parsed,
    now: explicitNow,
  };
}

export function createReceiverReadJobService(
  options: ReceiverReadJobServiceOptions,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion>;
export function createReceiverReadJobService(
  database: SqliteDatabase,
  clock?: ReceiverJobClock,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion>;
export function createReceiverReadJobService(
  optionsOrDatabase: ReceiverReadJobServiceOptions | SqliteDatabase,
  clock?: ReceiverJobClock,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion> {
  return createReceiverReadJobServiceWithCompletion(
    normalizeServiceOptions(optionsOrDatabase, clock),
  );
}

function createReceiverReadJobServiceWithOptions(
  options: ReceiverReadJobServiceOptions,
) {
  const { database } = options;
  const clock: ReceiverJobClock = options.clock ?? options.now ?? (() => new Date());

  function create(
    input: CreateReceiverReadJobInput,
    explicitNow?: Date,
  ): ReceiverReadJob;
  function create(
    receiverConnectionId: unknown,
    capability: unknown,
    input: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob;
  function create(
    inputOrReceiverConnectionId: CreateReceiverReadJobInput | unknown,
    capabilityOrNow?: unknown,
    inputOrNow?: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob {
    const parsed = readCreateArguments(
      inputOrReceiverConnectionId,
      capabilityOrNow,
      inputOrNow,
      explicitNow,
    );
    const now = readClockValue(clock, parsed.now);
    const timestamp = now.toISOString();
    const deadlineAt = new Date(
      now.getTime() + RECEIVER_READ_JOB_DEADLINE_MS,
    ).toISOString();
    const receiver = database.get<{ id: string }>(
      `SELECT id FROM receiver_connections WHERE id = ?`,
      [parsed.receiverConnectionId],
    );
    if (receiver === undefined) {
      throw new ReceiverReadJobError(
        "JOB_NOT_FOUND",
        "The receiver connection was not found.",
      );
    }
    const inputJson = assertSerializedJson(parsed.input, "input");
    const id = randomUUID();
    database.run(
      `
        INSERT INTO receiver_read_jobs (
          id, receiver_connection_id, capability, input_json, state,
          lease_generation, leased_connector_id, lease_expires_at,
          deadline_at, result_json, error_code, created_at, updated_at,
          completed_at
        ) VALUES (
          @id, @receiverConnectionId, @capability, @inputJson, @state,
          0, NULL, NULL, @deadlineAt, NULL, NULL, @createdAt, @updatedAt,
          NULL
        )
      `,
      {
        id,
        receiverConnectionId: parsed.receiverConnectionId,
        capability: parsed.capability,
        inputJson,
        deadlineAt,
        createdAt: timestamp,
        updatedAt: timestamp,
        state: RECEIVER_READ_JOB_QUEUED,
      },
    );
    return getReceiverReadJobOrThrow(database, id);
  }

  function createBusinessStateJob(
    receiverConnectionId: unknown,
    deliveryGuid: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob {
    return create(
      receiverConnectionId,
      RECEIVER_CAPABILITY_BUSINESS_STATE,
      { deliveryGuid },
      explicitNow,
    );
  }

  function createHealthJob(
    receiverConnectionId: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob {
    return create(
      receiverConnectionId,
      RECEIVER_CAPABILITY_HEALTH,
      {},
      explicitNow,
    );
  }

  function getById(jobIdInput: unknown): ReceiverReadJob | null {
    const jobId = readIdentifier(jobIdInput, "id");
    const row = getReceiverReadJobRow(database, jobId);
    return row === undefined ? null : mapReceiverReadJob(row);
  }

  function lease(
    jobId: unknown,
    authentication: AuthenticatedReceiverConnector,
    explicitNow?: Date,
  ): ReceiverReadJob;
  function lease(
    jobIdInput: unknown,
    authentication: AuthenticatedReceiverConnector,
    explicitNow?: Date,
  ): ReceiverReadJob {
    const jobId = readIdentifier(jobIdInput, "id");
    const now = readClockValue(clock, explicitNow);
    const timestamp = now.toISOString();
    const outcome = database.transaction(() => {
      const row = getReceiverReadJobRow(database, jobId);
      if (row === undefined) {
        throw new ReceiverReadJobError(
          "JOB_NOT_FOUND",
          "The receiver read job was not found.",
        );
      }
      const receiverConnectionId = readText(row, "receiverConnectionId");
      const auth = assertAuthenticatedReceiver(
        database,
        authentication,
        receiverConnectionId,
      );
      const state = readJobState(row);
      assertTerminalState(state);
      if (state !== RECEIVER_READ_JOB_QUEUED && state !== RECEIVER_READ_JOB_LEASED) {
        throw new ReceiverReadJobError(
          "JOB_NOT_AVAILABLE",
          "The receiver read job is not available for leasing.",
        );
      }
      const deadlineAt = readText(row, "deadlineAt");
      if (readDueDate(deadlineAt, "deadlineAt") <= now.getTime()) {
        markJobExpired(database, jobId, receiverConnectionId, timestamp);
        return { kind: "deadline" as const };
      }

      const generation = readLeaseGeneration(row);
      const oldLeaseExpiresAt = readNullableText(row, "leaseExpiresAt");
      if (state === RECEIVER_READ_JOB_LEASED) {
        if (oldLeaseExpiresAt === null) {
          throw new ReceiverReadJobError(
            "INVALID_STATE",
            "The leased receiver read job has no lease expiry.",
          );
        }
        if (readDueDate(oldLeaseExpiresAt, "leaseExpiresAt") > now.getTime()) {
          throw new ReceiverReadJobError(
            "JOB_ALREADY_LEASED",
            "The receiver read job is already leased.",
          );
        }
      }

      const leaseExpiresAt = new Date(
        now.getTime() + RECEIVER_READ_JOB_LEASE_MS,
      ).toISOString();
      const update = state === RECEIVER_READ_JOB_QUEUED
        ? database.run(
            `
              UPDATE receiver_read_jobs
                 SET state = ?,
                     lease_generation = lease_generation + 1,
                     leased_connector_id = ?,
                     lease_expires_at = ?,
                     updated_at = ?
               WHERE id = ? AND receiver_connection_id = ?
                 AND state = ? AND lease_generation = ?
                 AND leased_connector_id IS NULL AND lease_expires_at IS NULL
                 AND deadline_at = ?
            `,
            [
              RECEIVER_READ_JOB_LEASED,
              auth.connectorId,
              leaseExpiresAt,
              timestamp,
              jobId,
              receiverConnectionId,
              RECEIVER_READ_JOB_QUEUED,
              generation,
              deadlineAt,
            ],
          )
        : database.run(
            `
              UPDATE receiver_read_jobs
                 SET state = ?,
                     lease_generation = lease_generation + 1,
                     leased_connector_id = ?,
                     lease_expires_at = ?,
                     updated_at = ?
               WHERE id = ? AND receiver_connection_id = ?
                 AND state = ? AND lease_generation = ?
                 AND lease_expires_at = ?
                 AND deadline_at = ?
            `,
            [
              RECEIVER_READ_JOB_LEASED,
              auth.connectorId,
              leaseExpiresAt,
              timestamp,
              jobId,
              receiverConnectionId,
              RECEIVER_READ_JOB_LEASED,
              generation,
              oldLeaseExpiresAt,
              deadlineAt,
            ],
          );
      if (update.changes !== 1) {
        throw new ReceiverReadJobError(
          "JOB_NOT_AVAILABLE",
          "The receiver read job is no longer available for leasing.",
        );
      }
      return { kind: "leased" as const };
    }, "immediate");

    if (outcome.kind === "deadline") {
      throw new ReceiverReadJobError(
        "DEADLINE_EXPIRED",
        "The receiver read job deadline has expired.",
      );
    }
    return getReceiverReadJobOrThrow(database, jobId);
  }

  function leaseNext(
    authentication: AuthenticatedReceiverConnector,
    capability?: ReceiverCapability,
    explicitNow?: Date,
  ): ReceiverReadJob | null {
    const auth = readAuthentication(authentication);
    const now = readClockValue(clock, explicitNow);
    const nowIso = now.toISOString();
    // Authentication is checked before selecting a job. The selection query
    // therefore cannot be used to probe another receiver's queue.
    const row = database.transaction(() => {
      assertAuthenticatedReceiver(database, authentication, auth.receiverConnectionId);
      database.run(
        `
          UPDATE receiver_read_jobs
             SET state = ?,
                 leased_connector_id = NULL,
                 lease_expires_at = NULL,
                 error_code = ?,
                 completed_at = COALESCE(completed_at, ?),
                 updated_at = ?
           WHERE receiver_connection_id = ?
             AND state IN (?, ?)
             AND deadline_at <= ?
        `,
        [
          RECEIVER_READ_JOB_EXPIRED,
          "JOB_DEADLINE_EXPIRED",
          nowIso,
          nowIso,
          auth.receiverConnectionId,
          RECEIVER_READ_JOB_QUEUED,
          RECEIVER_READ_JOB_LEASED,
          nowIso,
        ],
      );
      return database.get<{ id: string }>(
      `
        SELECT id
          FROM receiver_read_jobs
         WHERE receiver_connection_id = ?
           AND deadline_at > ?
           AND (
             state = ?
             OR (state = ? AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
           )
           AND (? IS NULL OR capability = ?)
         ORDER BY created_at ASC, id ASC
         LIMIT 1
      `,
      [
        auth.receiverConnectionId,
        nowIso,
        RECEIVER_READ_JOB_QUEUED,
        RECEIVER_READ_JOB_LEASED,
        nowIso,
        capability ?? null,
        capability ?? null,
      ],
      );
    }, "immediate");
    if (row === undefined) return null;
    return lease(row.id, authentication, now);
  }

  return {
    create,
    createBusinessStateJob,
    createHealthJob,
    getById,
    lease,
    leaseNext,
  };
}

function parseCompletionResult(
  capability: ReceiverCapability,
  input: ReceiverReadJobInput,
  value: unknown,
): ReceiverReadJobResult {
  if (capability === RECEIVER_CAPABILITY_BUSINESS_STATE) {
    const businessInput = parseBusinessStateReadInput(input);
    return parseBusinessStateReadResult(value, businessInput.deliveryGuid);
  }
  return parseHealthReadResult(value);
}

function matchingLeaseGeneration(value: unknown, current: number): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value === current
  );
}

function sameTypedResult(
  persisted: ReceiverReadJobResult | null,
  incoming: ReceiverReadJobResult,
): boolean {
  if (persisted === null) return false;
  if ("deliveryGuid" in persisted && "deliveryGuid" in incoming) {
    return (
      persisted.schemaVersion === incoming.schemaVersion &&
      persisted.deliveryGuid === incoming.deliveryGuid &&
      persisted.mutationCount === incoming.mutationCount &&
      persisted.businessState === incoming.businessState &&
      persisted.observedAt === incoming.observedAt
    );
  }
  if ("healthStatus" in persisted && "healthStatus" in incoming) {
    return (
      persisted.schemaVersion === incoming.schemaVersion &&
      persisted.healthStatus === incoming.healthStatus &&
      persisted.observedAt === incoming.observedAt
    );
  }
  return false;
}

function isExactSucceededReplay(
  row: ReceiverReadJobRow,
  leaseGeneration: unknown,
  result: unknown,
): boolean {
  if (!matchingLeaseGeneration(leaseGeneration, readLeaseGeneration(row))) {
    return false;
  }
  const capability = readCapability(row);
  const input = readStoredInput(row, capability);
  let parsedResult: ReceiverReadJobResult;
  try {
    parsedResult = parseCompletionResult(capability, input, result);
  } catch (error) {
    if (error instanceof ReceiverConnectorValidationError) return false;
    throw error;
  }
  return sameTypedResult(readStoredResult(row, capability, input), parsedResult);
}

function isExactFailedReplay(
  row: ReceiverReadJobRow,
  leaseGeneration: unknown,
  errorCode: unknown,
): boolean {
  if (!matchingLeaseGeneration(leaseGeneration, readLeaseGeneration(row))) {
    return false;
  }
  let parsedErrorCode: string;
  try {
    parsedErrorCode = parseFailureCode(errorCode);
  } catch (error) {
    if (
      error instanceof ReceiverReadJobError &&
      error.code === "INVALID_INPUT"
    ) {
      return false;
    }
    throw error;
  }
  return readNullableText(row, "errorCode") === parsedErrorCode;
}

function assertLeaseGenerationMatches(
  supplied: unknown,
  current: number,
): void {
  const generation = parseLeaseGeneration(supplied);
  if (generation !== current) {
    throw new ReceiverReadJobError(
      "STALE_LEASE",
      "The receiver read job lease generation is stale.",
    );
  }
}

// Kept as a separate named implementation so both the factory and direct
// helpers expose the same completion/fencing primitive without a second store.
function createReceiverReadJobServiceWithCompletion(
  options: ReceiverReadJobServiceOptions,
) {
  const base = createReceiverReadJobServiceWithOptions(options);
  const clock: ReceiverJobClock = options.clock ?? options.now ?? (() => new Date());
  const { database } = options;

  function complete(
    jobId: unknown,
    authentication: AuthenticatedReceiverConnector,
    leaseGeneration: unknown,
    result: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob;
  function complete(
    jobIdInput: unknown,
    authentication: AuthenticatedReceiverConnector,
    leaseGeneration: unknown,
    result: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob {
    const jobId = readIdentifier(jobIdInput, "id");
    const now = readClockValue(clock, explicitNow);
    const timestamp = now.toISOString();
    const outcome = database.transaction(() => {
      const row = getReceiverReadJobRow(database, jobId);
      if (row === undefined) {
        throw new ReceiverReadJobError(
          "JOB_NOT_FOUND",
          "The receiver read job was not found.",
        );
      }
      const receiverConnectionId = readText(row, "receiverConnectionId");
      const auth = assertAuthenticatedReceiver(
        database,
        authentication,
        receiverConnectionId,
      );
      const state = readJobState(row);
      if (
        state === RECEIVER_READ_JOB_SUCCEEDED &&
        isExactSucceededReplay(row, leaseGeneration, result)
      ) {
        return { kind: "idempotent" as const };
      }
      if (
        state === RECEIVER_READ_JOB_SUCCEEDED ||
        state === RECEIVER_READ_JOB_FAILED
      ) {
        throw new ReceiverReadJobError(
          "JOB_ALREADY_COMPLETED",
          "The receiver read job is already terminal.",
        );
      }
      assertTerminalState(state);
      const deadlineAt = readText(row, "deadlineAt");
      if (readDueDate(deadlineAt, "deadlineAt") <= now.getTime()) {
        markJobExpired(database, jobId, receiverConnectionId, timestamp);
        return { kind: "deadline" as const };
      }
      if (state !== RECEIVER_READ_JOB_LEASED) {
        throw new ReceiverReadJobError(
          "JOB_NOT_LEASED",
          "The receiver read job is not currently leased.",
        );
      }
      const leasedConnectorId = readNullableText(row, "leasedConnectorId");
      if (leasedConnectorId === null || leasedConnectorId !== auth.connectorId) {
        throw new ReceiverReadJobError(
          "JOB_NOT_LEASED",
          "The receiver read job is leased to a different connector.",
        );
      }
      const currentGeneration = readLeaseGeneration(row);
      assertLeaseGenerationMatches(leaseGeneration, currentGeneration);
      const leaseExpiresAt = readNullableText(row, "leaseExpiresAt");
      if (
        leaseExpiresAt === null ||
        readDueDate(leaseExpiresAt, "leaseExpiresAt") <= now.getTime()
      ) {
        throw new ReceiverReadJobError(
          "LEASE_EXPIRED",
          "The receiver read job lease has expired.",
        );
      }

      const capability = readCapability(row);
      const input = readStoredInput(row, capability);
      const parsedResult = parseCompletionResult(capability, input, result);
      const resultJson = assertSerializedJson(parsedResult, "result");
      const update = database.run(
        `
          UPDATE receiver_read_jobs
             SET state = ?,
                 leased_connector_id = NULL,
                 lease_expires_at = NULL,
                 result_json = ?,
                 error_code = NULL,
                 updated_at = ?,
                 completed_at = ?
           WHERE id = ? AND receiver_connection_id = ?
             AND state = ? AND leased_connector_id = ?
             AND lease_generation = ? AND lease_expires_at = ?
             AND deadline_at = ?
        `,
        [
          RECEIVER_READ_JOB_SUCCEEDED,
          resultJson,
          timestamp,
          timestamp,
          jobId,
          receiverConnectionId,
          RECEIVER_READ_JOB_LEASED,
          auth.connectorId,
          currentGeneration,
          leaseExpiresAt,
          deadlineAt,
        ],
      );
      if (update.changes !== 1) {
        throw new ReceiverReadJobError(
          "JOB_NOT_AVAILABLE",
          "The receiver read job is no longer completable.",
        );
      }

      if (capability === RECEIVER_CAPABILITY_HEALTH) {
        const receiver = database.get<{ state: unknown }>(
          `SELECT state FROM receiver_connections WHERE id = ?`,
          [receiverConnectionId],
        );
        if (receiver === undefined) {
          throw new ReceiverReadJobError(
            "INVALID_STATE",
            "The receiver connection could not be read while completing health.",
          );
        }
        const receiverState = readReceiverState(receiver.state);
        const healthResult = parseHealthReadResult(result);
        const nextState = nextHealthState(
          receiverState,
          healthResult.healthStatus,
        );
        const receiverUpdate = database.run(
          `
            UPDATE receiver_connections
               SET state = ?,
                   last_health_status = ?,
                   last_health_at = ?,
                   updated_at = ?
             WHERE id = ?
          `,
          [
            nextState,
            healthResult.healthStatus,
            healthResult.observedAt,
            timestamp,
            receiverConnectionId,
          ],
        );
        if (receiverUpdate.changes !== 1) {
          throw new ReceiverReadJobError(
            "INVALID_STATE",
            "The receiver connection could not be updated while completing health.",
          );
        }
      }
      return { kind: "completed" as const };
    }, "immediate");

    if (outcome.kind === "deadline") {
      throw new ReceiverReadJobError(
        "DEADLINE_EXPIRED",
        "The receiver read job deadline has expired.",
      );
    }
    return getReceiverReadJobOrThrow(database, jobId);
  }

  function fail(
    jobId: unknown,
    authentication: AuthenticatedReceiverConnector,
    leaseGeneration: unknown,
    errorCode: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob;
  function fail(
    jobIdInput: unknown,
    authentication: AuthenticatedReceiverConnector,
    leaseGeneration: unknown,
    errorCode: unknown,
    explicitNow?: Date,
  ): ReceiverReadJob {
    const jobId = readIdentifier(jobIdInput, "id");
    const now = readClockValue(clock, explicitNow);
    const timestamp = now.toISOString();
    const outcome = database.transaction(() => {
      const row = getReceiverReadJobRow(database, jobId);
      if (row === undefined) {
        throw new ReceiverReadJobError(
          "JOB_NOT_FOUND",
          "The receiver read job was not found.",
        );
      }
      const receiverConnectionId = readText(row, "receiverConnectionId");
      const auth = assertAuthenticatedReceiver(
        database,
        authentication,
        receiverConnectionId,
      );
      const state = readJobState(row);
      if (
        state === RECEIVER_READ_JOB_FAILED &&
        isExactFailedReplay(row, leaseGeneration, errorCode)
      ) {
        return { kind: "idempotent" as const };
      }
      if (
        state === RECEIVER_READ_JOB_SUCCEEDED ||
        state === RECEIVER_READ_JOB_FAILED
      ) {
        throw new ReceiverReadJobError(
          "JOB_ALREADY_COMPLETED",
          "The receiver read job is already terminal.",
        );
      }
      assertTerminalState(state);
      const deadlineAt = readText(row, "deadlineAt");
      if (readDueDate(deadlineAt, "deadlineAt") <= now.getTime()) {
        markJobExpired(database, jobId, receiverConnectionId, timestamp);
        return { kind: "deadline" as const };
      }
      if (state !== RECEIVER_READ_JOB_LEASED) {
        throw new ReceiverReadJobError(
          "JOB_NOT_LEASED",
          "The receiver read job is not currently leased.",
        );
      }
      const leasedConnectorId = readNullableText(row, "leasedConnectorId");
      if (leasedConnectorId === null || leasedConnectorId !== auth.connectorId) {
        throw new ReceiverReadJobError(
          "JOB_NOT_LEASED",
          "The receiver read job is leased to a different connector.",
        );
      }
      const currentGeneration = readLeaseGeneration(row);
      assertLeaseGenerationMatches(leaseGeneration, currentGeneration);
      const leaseExpiresAt = readNullableText(row, "leaseExpiresAt");
      if (
        leaseExpiresAt === null ||
        readDueDate(leaseExpiresAt, "leaseExpiresAt") <= now.getTime()
      ) {
        throw new ReceiverReadJobError(
          "LEASE_EXPIRED",
          "The receiver read job lease has expired.",
        );
      }
      const parsedErrorCode = parseFailureCode(errorCode);
      const update = database.run(
        `
          UPDATE receiver_read_jobs
             SET state = ?,
                 leased_connector_id = NULL,
                 lease_expires_at = NULL,
                 result_json = NULL,
                 error_code = ?,
                 updated_at = ?,
                 completed_at = ?
           WHERE id = ? AND receiver_connection_id = ?
             AND state = ? AND leased_connector_id = ?
             AND lease_generation = ? AND lease_expires_at = ?
             AND deadline_at = ?
        `,
        [
          RECEIVER_READ_JOB_FAILED,
          parsedErrorCode,
          timestamp,
          timestamp,
          jobId,
          receiverConnectionId,
          RECEIVER_READ_JOB_LEASED,
          auth.connectorId,
          currentGeneration,
          leaseExpiresAt,
          deadlineAt,
        ],
      );
      if (update.changes !== 1) {
        throw new ReceiverReadJobError(
          "JOB_NOT_AVAILABLE",
          "The receiver read job is no longer completable.",
        );
      }
      return { kind: "failed" as const };
    }, "immediate");

    if (outcome.kind === "deadline") {
      throw new ReceiverReadJobError(
        "DEADLINE_EXPIRED",
        "The receiver read job deadline has expired.",
      );
    }
    return getReceiverReadJobOrThrow(database, jobId);
  }

  return { ...base, complete, fail };
}

export function createReceiverReadJobTransportService(
  options: ReceiverReadJobServiceOptions,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion>;
export function createReceiverReadJobTransportService(
  database: SqliteDatabase,
  clock?: ReceiverJobClock,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion>;
export function createReceiverReadJobTransportService(
  optionsOrDatabase: ReceiverReadJobServiceOptions | SqliteDatabase,
  clock?: ReceiverJobClock,
): ReturnType<typeof createReceiverReadJobServiceWithCompletion> {
  return createReceiverReadJobServiceWithCompletion(
    normalizeServiceOptions(optionsOrDatabase, clock),
  );
}


/** Alias used by the 1b transport adapter; it is the same fenced job store. */
export const createReceiverJobService = createReceiverReadJobService;

export function getReceiverReadJob(
  database: SqliteDatabase,
  jobId: string,
): ReceiverReadJob | null {
  return createReceiverReadJobService(database).getById(jobId);
}

export function createReceiverReadJob(
  database: SqliteDatabase,
  input: CreateReceiverReadJobInput,
  now?: Date,
): ReceiverReadJob;
export function createReceiverReadJob(
  database: SqliteDatabase,
  receiverConnectionId: unknown,
  capability: unknown,
  input: unknown,
  now?: Date,
): ReceiverReadJob;
export function createReceiverReadJob(
  database: SqliteDatabase,
  inputOrReceiverConnectionId: CreateReceiverReadJobInput | unknown,
  capabilityOrInput?: unknown,
  inputOrNow?: unknown,
  explicitNow?: Date,
): ReceiverReadJob {
  const service = createReceiverReadJobService(database);
  if (isObject(inputOrReceiverConnectionId) &&
      Object.prototype.hasOwnProperty.call(inputOrReceiverConnectionId, "receiverConnectionId")) {
    return service.create(
      inputOrReceiverConnectionId as unknown as CreateReceiverReadJobInput,
      capabilityOrInput instanceof Date ? capabilityOrInput : undefined,
    );
  }
  return service.create(
    inputOrReceiverConnectionId,
    capabilityOrInput,
    inputOrNow,
    explicitNow,
  );
}

export function leaseReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  now?: Date,
): ReceiverReadJob;
export function leaseReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  explicitNow?: Date,
): ReceiverReadJob {
  return createReceiverReadJobService(database).lease(
    jobId,
    authentication,
    explicitNow,
  );
}

export function completeReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  leaseGeneration: unknown,
  result: unknown,
  now?: Date,
): ReceiverReadJob;
export function completeReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  leaseGeneration: unknown,
  result: unknown,
  explicitNow?: Date,
): ReceiverReadJob {
  return createReceiverReadJobService(database).complete(
    jobId,
    authentication,
    leaseGeneration,
    result,
    explicitNow,
  );
}


export function failReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  leaseGeneration: unknown,
  errorCode: unknown,
  now?: Date,
): ReceiverReadJob;
export function failReceiverReadJob(
  database: SqliteDatabase,
  jobId: unknown,
  authentication: AuthenticatedReceiverConnector,
  leaseGeneration: unknown,
  errorCode: unknown,
  explicitNow?: Date,
): ReceiverReadJob {
  return createReceiverReadJobService(database).fail(
    jobId,
    authentication,
    leaseGeneration,
    errorCode,
    explicitNow,
  );
}
