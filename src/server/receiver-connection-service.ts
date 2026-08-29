import {
  createHash,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { getApplicationConnection } from "@/server/github-connection-service";
import type { ApplicationConnection } from "@/domain/github-integration";
import type { SqliteDatabase } from "@/server/database";
import {
  parseReceiverCapabilities,
  parseReceiverEnrollment,
  parseReceiverProtocolVersion,
  RECEIVER_CAPABILITIES,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_UNHEALTHY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
  RECEIVER_CONNECTOR_PROTOCOL_VERSION,
  RECEIVER_READ_JOB_DEADLINE_MS,
  RECEIVER_READ_JOB_QUEUED,
  type ReceiverConnection,
  type ReceiverConnectionState,
  type ReceiverHealthStatus,
  type ParsedReceiverEnrollment,
} from "@/domain/receiver-connector";
import { isRecord, timingSafeStringEqual } from "@/domain/github-integration";

export const RECEIVER_ENROLLMENT_TTL_MS = 15 * 60 * 1000;

const ENROLLMENT_TOKEN_HASH_DOMAIN = "redrive/receiver-enrollment-token/v1";
const CONNECTOR_SECRET_HASH_DOMAIN = "redrive/receiver-connector-secret/v1";

export type ReceiverConnectionErrorCode =
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "CONFLICT"
  | "TOKEN_INVALID"
  | "TOKEN_EXPIRED"
  | "ENROLLMENT_REPLAY_MISMATCH"
  | "ALREADY_ENROLLED"
  | "UNAUTHENTICATED"
  | "INVALID_STATE";

export class ReceiverConnectionError extends Error {
  readonly code: ReceiverConnectionErrorCode;

  constructor(code: ReceiverConnectionErrorCode, message: string) {
    super(message);
    this.name = "ReceiverConnectionError";
    this.code = code;
  }
}

export class ReceiverConnectorAuthenticationError extends ReceiverConnectionError {
  constructor() {
    super(
      "UNAUTHENTICATED",
      "Receiver connector authentication failed.",
    );
    this.name = "ReceiverConnectorAuthenticationError";
  }
}

export interface ReceiverEnrollmentIssue {
  receiverConnection: ReceiverConnection;
  token: string;
  expiresAt: string;
  /** Alias for callers that use the wire field name. */
  readonly enrollmentToken: string;
  /** Alias for callers that use the persisted field name. */
  readonly enrollmentExpiresAt: string;
}

export type ReceiverEnrollmentDisposition = "ENROLLED" | "ALREADY_ENROLLED";

export interface ReceiverEnrollmentResult {
  receiverConnection: ReceiverConnection;
  disposition: ReceiverEnrollmentDisposition;
  healthJobId: string | null;
}

export interface AuthenticatedReceiverConnector {
  receiverConnectionId: string;
  connectorId: string;
  receiverConnection: ReceiverConnection;
}

const authenticatedReceiverConnectors = new WeakSet<object>();

export function isAuthenticatedReceiverConnector(
  value: unknown,
): value is AuthenticatedReceiverConnector {
  return (
    value !== null &&
    typeof value === "object" &&
    authenticatedReceiverConnectors.has(value)
  );
}

interface ReceiverConnectionRow extends Record<string, unknown> {
  id: unknown;
  applicationConnectionId: unknown;
  state: unknown;
  enrollmentTokenHash: unknown;
  enrollmentExpiresAt: unknown;
  enrollmentConsumedAt: unknown;
  connectorId: unknown;
  connectorSecretHash: unknown;
  protocolVersion: unknown;
  capabilitiesJson: unknown;
  enrolledAt: unknown;
  lastSeenAt: unknown;
  lastHealthStatus: unknown;
  lastHealthAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const receiverConnectionColumns = `
  id,
  application_connection_id AS applicationConnectionId,
  state,
  enrollment_token_hash AS enrollmentTokenHash,
  enrollment_expires_at AS enrollmentExpiresAt,
  enrollment_consumed_at AS enrollmentConsumedAt,
  connector_id AS connectorId,
  connector_secret_hash AS connectorSecretHash,
  protocol_version AS protocolVersion,
  capabilities_json AS capabilitiesJson,
  enrolled_at AS enrolledAt,
  last_seen_at AS lastSeenAt,
  last_health_status AS lastHealthStatus,
  last_health_at AS lastHealthAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Receiver connection row has an invalid ${field} value.`);
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
    throw new Error(`Receiver connection row has an invalid ${field} value.`);
  }
  return value;
}

function readState(row: Record<string, unknown>): ReceiverConnectionState {
  const state = readText(row, "state");
  if (
    state !== RECEIVER_CONNECTION_WAITING_FOR_RECEIVER &&
    state !== RECEIVER_CONNECTION_VERIFYING &&
    state !== RECEIVER_CONNECTION_READY &&
    state !== RECEIVER_CONNECTION_UNHEALTHY
  ) {
    throw new Error("Receiver connection row has an invalid state.");
  }
  return state;
}

function readHealthStatus(
  row: Record<string, unknown>,
): ReceiverHealthStatus | null {
  const value = readNullableText(row, "lastHealthStatus");
  if (value === null) return null;
  if (value !== "HEALTHY" && value !== "UNHEALTHY") {
    throw new Error("Receiver connection row has an invalid health status.");
  }
  return value;
}

function readStoredCapabilities(
  row: Record<string, unknown>,
): ReceiverConnection["capabilities"] {
  const value = readNullableText(row, "capabilitiesJson");
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new Error("Receiver connection row contains invalid capabilities JSON.");
  }
  return parseReceiverCapabilities(parsed);
}

function mapReceiverConnectionRow(
  row: ReceiverConnectionRow,
): ReceiverConnection {
  const protocolValue = readNullableText(row, "protocolVersion");
  const protocolVersion =
    protocolValue === null ? null : parseReceiverProtocolVersion(protocolValue);
  return {
    id: readText(row, "id"),
    applicationConnectionId: readText(row, "applicationConnectionId"),
    state: readState(row),
    enrollmentExpiresAt: readNullableText(row, "enrollmentExpiresAt"),
    enrollmentConsumedAt: readNullableText(row, "enrollmentConsumedAt"),
    connectorId: readNullableText(row, "connectorId"),
    protocolVersion,
    capabilities: readStoredCapabilities(row),
    enrolledAt: readNullableText(row, "enrolledAt"),
    lastSeenAt: readNullableText(row, "lastSeenAt"),
    lastHealthStatus: readHealthStatus(row),
    lastHealthAt: readNullableText(row, "lastHealthAt"),
    createdAt: readText(row, "createdAt"),
    updatedAt: readText(row, "updatedAt"),
  };
}

function getReceiverConnectionRowById(
  database: SqliteDatabase,
  receiverConnectionId: string,
): ReceiverConnectionRow | undefined {
  return database.get<ReceiverConnectionRow>(
    `SELECT ${receiverConnectionColumns}
       FROM receiver_connections
      WHERE id = ?`,
    [receiverConnectionId],
  );
}

function getReceiverConnectionRowByApplicationConnectionId(
  database: SqliteDatabase,
  applicationConnectionId: string,
): ReceiverConnectionRow | undefined {
  return database.get<ReceiverConnectionRow>(
    `SELECT ${receiverConnectionColumns}
       FROM receiver_connections
      WHERE application_connection_id = ?`,
    [applicationConnectionId],
  );
}

function readReceiverConnection(
  database: SqliteDatabase,
  receiverConnectionId: string,
): ReceiverConnection | null {
  const row = getReceiverConnectionRowById(database, receiverConnectionId);
  return row === undefined ? null : mapReceiverConnectionRow(row);
}

function readRequiredConnectionId(value: unknown): string {
  const candidate =
    isRecord(value) &&
    Object.prototype.hasOwnProperty.call(value, "applicationConnectionId")
      ? value.applicationConnectionId
      : value;
  if (
    typeof candidate !== "string" ||
    candidate.length === 0 ||
    candidate.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(candidate)
  ) {
    throw new ReceiverConnectionError(
      "INVALID_INPUT",
      "The application connection identifier is invalid.",
    );
  }
  return candidate;
}

function readClockValue(clock: ReceiverClock, explicit?: Date): Date {
  const value = explicit ?? clock();
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new ReceiverConnectionError(
      "INVALID_INPUT",
      "A valid clock value is required.",
    );
  }
  return new Date(date.getTime());
}

function hashSecret(domain: string, secret: string): string {
  return createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(secret, "utf8")
    .digest("hex");
}

export function hashReceiverEnrollmentToken(token: string): string {
  return hashSecret(ENROLLMENT_TOKEN_HASH_DOMAIN, token);
}

export function hashReceiverConnectorSecret(secret: string): string {
  return hashSecret(CONNECTOR_SECRET_HASH_DOMAIN, secret);
}

function generateEnrollmentToken(): string {
  return randomBytes(32).toString("base64url");
}

function compareHash(stored: unknown, candidate: string): boolean {
  return typeof stored === "string" && timingSafeStringEqual(stored, candidate);
}

function requireApplicationConnection(
  database: SqliteDatabase,
  applicationConnectionIdInput: unknown,
): ApplicationConnection {
  const applicationConnectionId = readRequiredConnectionId(
    applicationConnectionIdInput,
  );
  const connection = getApplicationConnection(database, applicationConnectionId);
  if (connection === null) {
    throw new ReceiverConnectionError(
      "NOT_FOUND",
      "The application connection was not found.",
    );
  }
  return connection;
}

function makeIssueResult(
  receiverConnection: ReceiverConnection,
  token: string,
  expiresAt: string,
): ReceiverEnrollmentIssue {
  const result = { receiverConnection, token, expiresAt } as ReceiverEnrollmentIssue;
  Object.defineProperties(result, {
    enrollmentToken: { value: token, enumerable: false },
    enrollmentExpiresAt: { value: expiresAt, enumerable: false },
  });
  return result;
}

function parseEnrollmentForReplay(
  row: ReceiverConnectionRow,
  enrollment: ParsedReceiverEnrollment,
): boolean {
  const connectorId = readNullableText(row, "connectorId");
  const connectorSecretHash = readNullableText(row, "connectorSecretHash");
  const protocolVersion = readNullableText(row, "protocolVersion");
  const capabilitiesJson = readNullableText(row, "capabilitiesJson");
  if (
    connectorId === null ||
    connectorSecretHash === null ||
    protocolVersion === null ||
    capabilitiesJson === null
  ) {
    return false;
  }

  let storedCapabilities: unknown;
  try {
    storedCapabilities = JSON.parse(capabilitiesJson) as unknown;
  } catch {
    return false;
  }
  let canonicalStoredCapabilities: string;
  try {
    canonicalStoredCapabilities = JSON.stringify(
      parseReceiverCapabilities(storedCapabilities),
    );
  } catch {
    return false;
  }
  return (
    connectorId === enrollment.connectorId &&
    compareHash(
      connectorSecretHash,
      hashReceiverConnectorSecret(enrollment.connectorSecret),
    ) &&
    protocolVersion === enrollment.protocolVersion &&
    canonicalStoredCapabilities === JSON.stringify(enrollment.capabilities)
  );
}

function findEnrollmentHealthJobId(
  database: SqliteDatabase,
  receiverConnectionId: string,
): string | null {
  const row = database.get<{ id: string }>(
    `
      SELECT id
        FROM receiver_read_jobs
       WHERE receiver_connection_id = ? AND capability = ?
       ORDER BY created_at ASC, id ASC
       LIMIT 1
    `,
    [receiverConnectionId, RECEIVER_CAPABILITY_HEALTH],
  );
  return row?.id ?? null;
}

function createHealthReadJobWithinTransaction(
  database: SqliteDatabase,
  receiverConnectionId: string,
  now: Date,
): string {
  const id = randomUUID();
  const createdAt = now.toISOString();
  const deadlineAt = new Date(
    now.getTime() + RECEIVER_READ_JOB_DEADLINE_MS,
  ).toISOString();
  database.run(
    `
      INSERT INTO receiver_read_jobs (
        id, receiver_connection_id, capability, input_json, state,
        lease_generation, leased_connector_id, lease_expires_at, deadline_at,
        result_json, error_code, created_at, updated_at, completed_at
      ) VALUES (
        @id, @receiverConnectionId, @capability, @inputJson, @state,
        0, NULL, NULL, @deadlineAt,
        NULL, NULL, @createdAt, @updatedAt, NULL
      )
    `,
    {
      id,
      receiverConnectionId,
      capability: RECEIVER_CAPABILITY_HEALTH,
      inputJson: "{}",
      state: RECEIVER_READ_JOB_QUEUED,
      deadlineAt,
      createdAt,
      updatedAt: createdAt,
    },
  );
  return id;
}

type ReceiverClock = () => Date | string;

export interface ReceiverConnectionServiceOptions {
  database: SqliteDatabase;
  clock?: ReceiverClock;
  /** Alias retained for service callers that name the dependency `now`. */
  now?: ReceiverClock;
  tokenGenerator?: () => string;
}

function normalizeServiceOptions(
  optionsOrDatabase: ReceiverConnectionServiceOptions | SqliteDatabase,
  clock?: ReceiverClock,
): ReceiverConnectionServiceOptions {
  if ("database" in optionsOrDatabase) return optionsOrDatabase;
  return { database: optionsOrDatabase, clock };
}

export function createReceiverConnectionService(
  options: ReceiverConnectionServiceOptions,
): ReturnType<typeof createReceiverConnectionServiceWithOptions>;
export function createReceiverConnectionService(
  database: SqliteDatabase,
  clock?: ReceiverClock,
): ReturnType<typeof createReceiverConnectionServiceWithOptions>;
export function createReceiverConnectionService(
  optionsOrDatabase: ReceiverConnectionServiceOptions | SqliteDatabase,
  clock?: ReceiverClock,
): ReturnType<typeof createReceiverConnectionServiceWithOptions> {
  return createReceiverConnectionServiceWithOptions(
    normalizeServiceOptions(optionsOrDatabase, clock),
  );
}

function createReceiverConnectionServiceWithOptions(
  options: ReceiverConnectionServiceOptions,
) {
  const { database } = options;
  const clock: ReceiverClock = options.clock ?? options.now ?? (() => new Date());
  const tokenGenerator = options.tokenGenerator ?? generateEnrollmentToken;

  function issue(
    applicationConnectionIdInput: unknown,
    explicitNow?: Date,
  ): ReceiverEnrollmentIssue {
    const applicationConnectionId = readRequiredConnectionId(
      applicationConnectionIdInput,
    );
    requireApplicationConnection(database, applicationConnectionId);
    const now = readClockValue(clock, explicitNow);
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + RECEIVER_ENROLLMENT_TTL_MS,
    ).toISOString();
    const token = tokenGenerator();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 4096
    ) {
      throw new ReceiverConnectionError(
        "INVALID_INPUT",
        "The enrollment token generator returned an invalid token.",
      );
    }
    const tokenHash = hashReceiverEnrollmentToken(token);

    const result = database.transaction(() => {
      let row = getReceiverConnectionRowByApplicationConnectionId(
        database,
        applicationConnectionId,
      );
      let created = false;
      if (row === undefined) {
        const receiverConnectionId = randomUUID();
        const insertion = database.run(
          `
            INSERT INTO receiver_connections (
              id, application_connection_id, state,
              enrollment_token_hash, enrollment_expires_at,
              enrollment_consumed_at, connector_id, connector_secret_hash,
              protocol_version, capabilities_json, enrolled_at, last_seen_at,
              last_health_status, last_health_at, created_at, updated_at
            ) VALUES (
              @id, @applicationConnectionId, @state,
              @enrollmentTokenHash, @enrollmentExpiresAt,
              NULL, NULL, NULL, NULL, NULL, NULL, NULL,
              NULL, NULL, @createdAt, @updatedAt
            )
            ON CONFLICT (application_connection_id) DO NOTHING
          `,
          {
            id: receiverConnectionId,
            applicationConnectionId,
            state: RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
            enrollmentTokenHash: tokenHash,
            enrollmentExpiresAt: expiresAt,
            createdAt,
            updatedAt: createdAt,
          },
        );
        created = insertion.changes === 1;
        row = getReceiverConnectionRowByApplicationConnectionId(
          database,
          applicationConnectionId,
        );
        if (row === undefined) {
          throw new Error("Receiver connection could not be created.");
        }
        // A concurrent caller can only reach here after the immediate
        // transaction has waited. Its pending token is authoritative.
        if (readNullableText(row, "enrollmentTokenHash") !== tokenHash) {
          const pendingExpiresAt = readNullableText(
            row,
            "enrollmentExpiresAt",
          );
          const consumedAt = readNullableText(row, "enrollmentConsumedAt");
          if (
            consumedAt === null &&
            pendingExpiresAt !== null &&
            Date.parse(pendingExpiresAt) > now.getTime()
          ) {
            throw new ReceiverConnectionError(
              "CONFLICT",
              "A receiver enrollment token is already pending.",
            );
          }
        }
      }

      const state = readState(row);
      const consumedAt = readNullableText(row, "enrollmentConsumedAt");
      const connectorId = readNullableText(row, "connectorId");
      if (consumedAt !== null || connectorId !== null) {
        throw new ReceiverConnectionError(
          "ALREADY_ENROLLED",
          "The receiver connector is already enrolled.",
        );
      }
      if (state !== RECEIVER_CONNECTION_WAITING_FOR_RECEIVER) {
        throw new ReceiverConnectionError(
          "INVALID_STATE",
          "The receiver connection is not awaiting enrollment.",
        );
      }

      const existingTokenHash = readNullableText(row, "enrollmentTokenHash");
      const existingExpiresAt = readNullableText(row, "enrollmentExpiresAt");
      const hasUnexpiredPendingToken =
        !created &&
        existingTokenHash !== null &&
        consumedAt === null &&
        existingExpiresAt !== null &&
        Number.isFinite(Date.parse(existingExpiresAt)) &&
        Date.parse(existingExpiresAt) > now.getTime();
      if (hasUnexpiredPendingToken) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "A receiver enrollment token is already pending.",
        );
      }

      const update = database.run(
        `
          UPDATE receiver_connections
             SET enrollment_token_hash = ?,
                 enrollment_expires_at = ?,
                 enrollment_consumed_at = NULL,
                 updated_at = ?
           WHERE id = ? AND state = ? AND enrollment_consumed_at IS NULL
             AND connector_id IS NULL
        `,
        [
          tokenHash,
          expiresAt,
          createdAt,
          readText(row, "id"),
          RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
        ],
      );
      if (update.changes !== 1) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "The receiver enrollment changed before it could be issued.",
        );
      }
      const updated = getReceiverConnectionRowById(
        database,
        readText(row, "id"),
      );
      if (updated === undefined) {
        throw new Error("Receiver enrollment could not be read back.");
      }
      return mapReceiverConnectionRow(updated);
    }, "immediate");

    return makeIssueResult(result, token, expiresAt);
  }

  function reissue(
    applicationConnectionIdInput: unknown,
    explicitNow?: Date,
  ): ReceiverEnrollmentIssue {
    // Reissue has the same durable operation as issue, but first verifies that
    // the connection exists. The issue transaction replaces an expired token;
    // this method's only semantic difference is that a live pending token is
    // explicitly replaced.
    const applicationConnectionId = readRequiredConnectionId(
      applicationConnectionIdInput,
    );
    requireApplicationConnection(database, applicationConnectionId);
    const now = readClockValue(clock, explicitNow);
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + RECEIVER_ENROLLMENT_TTL_MS,
    ).toISOString();
    const token = tokenGenerator();
    if (
      typeof token !== "string" ||
      token.length === 0 ||
      token.length > 4096
    ) {
      throw new ReceiverConnectionError(
        "INVALID_INPUT",
        "The enrollment token generator returned an invalid token.",
      );
    }
    const tokenHash = hashReceiverEnrollmentToken(token);

    const result = database.transaction(() => {
      const row = getReceiverConnectionRowByApplicationConnectionId(
        database,
        applicationConnectionId,
      );
      if (row === undefined) {
        throw new ReceiverConnectionError(
          "NOT_FOUND",
          "The receiver connection was not found.",
        );
      }
      const state = readState(row);
      const consumedAt = readNullableText(row, "enrollmentConsumedAt");
      const connectorId = readNullableText(row, "connectorId");
      if (consumedAt !== null || connectorId !== null) {
        throw new ReceiverConnectionError(
          "ALREADY_ENROLLED",
          "The receiver connector is already enrolled.",
        );
      }
      if (readNullableText(row, "enrollmentTokenHash") === null) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "There is no pending receiver enrollment to reissue.",
        );
      }
      if (state !== RECEIVER_CONNECTION_WAITING_FOR_RECEIVER) {
        throw new ReceiverConnectionError(
          "INVALID_STATE",
          "The receiver connection is not awaiting enrollment.",
        );
      }
      const update = database.run(
        `
          UPDATE receiver_connections
             SET enrollment_token_hash = ?,
                 enrollment_expires_at = ?,
                 enrollment_consumed_at = NULL,
                 updated_at = ?
           WHERE id = ? AND state = ? AND enrollment_consumed_at IS NULL
             AND connector_id IS NULL
        `,
        [
          tokenHash,
          expiresAt,
          createdAt,
          readText(row, "id"),
          RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
        ],
      );
      if (update.changes !== 1) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "The receiver enrollment changed before it could be reissued.",
        );
      }
      const updated = getReceiverConnectionRowById(
        database,
        readText(row, "id"),
      );
      if (updated === undefined) {
        throw new Error("Receiver enrollment could not be read back.");
      }
      return mapReceiverConnectionRow(updated);
    }, "immediate");

    return makeIssueResult(result, token, expiresAt);
  }

  function enroll(
    input: unknown,
    explicitNow?: Date,
  ): ReceiverEnrollmentResult {
    const enrollment = parseReceiverEnrollment(input);
    const now = readClockValue(clock, explicitNow);
    const timestamp = now.toISOString();
    const tokenHash = hashReceiverEnrollmentToken(enrollment.enrollmentToken);
    const connectorSecretHash = hashReceiverConnectorSecret(
      enrollment.connectorSecret,
    );

    return database.transaction(() => {
      const rows = database.all<ReceiverConnectionRow>(
        `SELECT ${receiverConnectionColumns}
           FROM receiver_connections
          WHERE enrollment_token_hash = ?`,
        [tokenHash],
      );
      if (rows.length === 0) {
        throw new ReceiverConnectionError(
          "TOKEN_INVALID",
          "The receiver enrollment token is invalid.",
        );
      }
      if (rows.length !== 1) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "The receiver enrollment token is bound ambiguously.",
        );
      }
      const row = rows[0];
      if (!compareHash(row.enrollmentTokenHash, tokenHash)) {
        throw new ReceiverConnectionError(
          "TOKEN_INVALID",
          "The receiver enrollment token is invalid.",
        );
      }

      const consumedAt = readNullableText(row, "enrollmentConsumedAt");
      if (consumedAt !== null) {
        if (!parseEnrollmentForReplay(row, enrollment)) {
          throw new ReceiverConnectionError(
            "ENROLLMENT_REPLAY_MISMATCH",
            "The receiver enrollment retry does not match the established connector.",
          );
        }
        const receiverConnection = mapReceiverConnectionRow(row);
        return {
          receiverConnection,
          disposition: "ALREADY_ENROLLED" as const,
          healthJobId: findEnrollmentHealthJobId(
            database,
            readText(row, "id"),
          ),
        };
      }

      const expiresAt = readNullableText(row, "enrollmentExpiresAt");
      const parsedExpiresAt = expiresAt === null ? NaN : Date.parse(expiresAt);
      if (!Number.isFinite(parsedExpiresAt) || parsedExpiresAt <= now.getTime()) {
        throw new ReceiverConnectionError(
          "TOKEN_EXPIRED",
          "The receiver enrollment token has expired.",
        );
      }
      if (readState(row) !== RECEIVER_CONNECTION_WAITING_FOR_RECEIVER) {
        throw new ReceiverConnectionError(
          "INVALID_STATE",
          "The receiver connection is not awaiting enrollment.",
        );
      }
      if (
        readNullableText(row, "connectorId") !== null ||
        readNullableText(row, "connectorSecretHash") !== null
      ) {
        throw new ReceiverConnectionError(
          "INVALID_STATE",
          "The receiver connection contains an incomplete enrollment.",
        );
      }

      const existingConnector = database.get<{ id: string }>(
        `SELECT id FROM receiver_connections WHERE connector_id = ?`,
        [enrollment.connectorId],
      );
      if (existingConnector !== undefined && existingConnector.id !== readText(row, "id")) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "The connector identifier is already enrolled.",
        );
      }

      const receiverConnectionId = readText(row, "id");
      const capabilitiesJson = JSON.stringify(enrollment.capabilities);
      const update = database.run(
        `
          UPDATE receiver_connections
             SET connector_id = ?,
                 connector_secret_hash = ?,
                 protocol_version = ?,
                 capabilities_json = ?,
                 enrollment_consumed_at = ?,
                 enrolled_at = ?,
                 state = ?,
                 updated_at = ?
           WHERE id = ? AND state = ? AND enrollment_consumed_at IS NULL
             AND connector_id IS NULL AND connector_secret_hash IS NULL
        `,
        [
          enrollment.connectorId,
          connectorSecretHash,
          enrollment.protocolVersion,
          capabilitiesJson,
          timestamp,
          timestamp,
          RECEIVER_CONNECTION_VERIFYING,
          timestamp,
          receiverConnectionId,
          RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
        ],
      );
      if (update.changes !== 1) {
        throw new ReceiverConnectionError(
          "CONFLICT",
          "The receiver enrollment changed before it could be completed.",
        );
      }
      const healthJobId = createHealthReadJobWithinTransaction(
        database,
        receiverConnectionId,
        now,
      );
      const enrolledRow = getReceiverConnectionRowById(
        database,
        receiverConnectionId,
      );
      if (enrolledRow === undefined) {
        throw new Error("Enrolled receiver connection could not be read back.");
      }
      return {
        receiverConnection: mapReceiverConnectionRow(enrolledRow),
        disposition: "ENROLLED" as const,
        healthJobId,
      };
    }, "immediate");
  }

  function authenticateWithValues(
    connectorId: unknown,
    connectorSecret: unknown,
    explicitNow?: Date,
  ): AuthenticatedReceiverConnector {
    if (
      typeof connectorId !== "string" ||
      connectorId.length === 0 ||
      connectorId.length > 255 ||
      typeof connectorSecret !== "string" ||
      connectorSecret.length === 0 ||
      connectorSecret.length > 4096
    ) {
      throw new ReceiverConnectorAuthenticationError();
    }
    const row = database.get<ReceiverConnectionRow>(
      `SELECT ${receiverConnectionColumns}
         FROM receiver_connections
        WHERE connector_id = ?`,
      [connectorId],
    );
    if (row === undefined) {
      throw new ReceiverConnectorAuthenticationError();
    }
    const storedSecretHash = row.connectorSecretHash;
    if (
      typeof storedSecretHash !== "string" ||
      !compareHash(
        storedSecretHash,
        hashReceiverConnectorSecret(connectorSecret),
      )
    ) {
      throw new ReceiverConnectorAuthenticationError();
    }
    const now = readClockValue(clock, explicitNow).toISOString();
    const update = database.run(
      `
        UPDATE receiver_connections
           SET last_seen_at = ?, updated_at = ?
         WHERE id = ? AND connector_id = ?
           AND connector_secret_hash = ?
      `,
      [now, now, readText(row, "id"), connectorId, storedSecretHash],
    );
    if (update.changes !== 1) {
      throw new ReceiverConnectorAuthenticationError();
    }
    const updatedRow = getReceiverConnectionRowById(
      database,
      readText(row, "id"),
    );
    if (updatedRow === undefined) {
      throw new ReceiverConnectorAuthenticationError();
    }
    const receiverConnection = mapReceiverConnectionRow(updatedRow);
    const authentication = Object.freeze({
      receiverConnectionId: receiverConnection.id,
      connectorId,
      receiverConnection,
    });
    authenticatedReceiverConnectors.add(authentication);
    return authentication;
  }

  function authenticate(
    input: { connectorId: unknown; connectorSecret: unknown },
    explicitNow?: Date,
  ): AuthenticatedReceiverConnector;
  function authenticate(
    connectorId: unknown,
    connectorSecret: unknown,
    explicitNow?: Date,
  ): AuthenticatedReceiverConnector;
  function authenticate(
    inputOrConnectorId: { connectorId: unknown; connectorSecret: unknown } | unknown,
    secretOrNow?: unknown,
    explicitNow?: Date,
  ): AuthenticatedReceiverConnector {
    if (
      inputOrConnectorId !== null &&
      typeof inputOrConnectorId === "object" &&
      "connectorId" in inputOrConnectorId &&
      "connectorSecret" in inputOrConnectorId
    ) {
      return authenticateWithValues(
        inputOrConnectorId.connectorId,
        inputOrConnectorId.connectorSecret,
        secretOrNow instanceof Date ? secretOrNow : explicitNow,
      );
    }
    return authenticateWithValues(
      inputOrConnectorId,
      secretOrNow,
      explicitNow,
    );
  }

  function getById(receiverConnectionId: string): ReceiverConnection | null {
    return readReceiverConnection(database, receiverConnectionId);
  }

  function getByApplicationConnectionId(
    applicationConnectionId: string,
  ): ReceiverConnection | null {
    const row = getReceiverConnectionRowByApplicationConnectionId(
      database,
      applicationConnectionId,
    );
    return row === undefined ? null : mapReceiverConnectionRow(row);
  }

  return {
    issue,
    reissue,
    enroll,
    authenticate,
    getById,
    getByApplicationConnectionId,
  };
}

/**
 * Authentication has its own named factory so the later HTTP adapter does not
 * need to depend on enrollment issuance.
 */
export const createReceiverConnectorAuthService =
  createReceiverConnectionService;

export function createReceiverEnrollmentService(
  options: ReceiverConnectionServiceOptions,
): ReturnType<typeof createReceiverConnectionService>;
export function createReceiverEnrollmentService(
  database: SqliteDatabase,
  clock?: ReceiverClock,
): ReturnType<typeof createReceiverConnectionService>;
export function createReceiverEnrollmentService(
  optionsOrDatabase: ReceiverConnectionServiceOptions | SqliteDatabase,
  clock?: ReceiverClock,
): ReturnType<typeof createReceiverConnectionService> {
  return "database" in optionsOrDatabase
    ? createReceiverConnectionService(optionsOrDatabase)
    : createReceiverConnectionService(optionsOrDatabase, clock);
}

export function getReceiverConnection(
  database: SqliteDatabase,
  receiverConnectionId: string,
): ReceiverConnection | null {
  return readReceiverConnection(database, receiverConnectionId);
}

export function getReceiverConnectionForApplication(
  database: SqliteDatabase,
  applicationConnectionId: string,
): ReceiverConnection | null {
  const row = getReceiverConnectionRowByApplicationConnectionId(
    database,
    applicationConnectionId,
  );
  return row === undefined ? null : mapReceiverConnectionRow(row);
}

export const getReceiverConnectionForApplicationConnection =
  getReceiverConnectionForApplication;

export function authenticateReceiverConnector(
  database: SqliteDatabase,
  connectorId: unknown,
  connectorSecret: unknown,
  now?: Date,
): AuthenticatedReceiverConnector {
  return createReceiverConnectionService(database).authenticate(
    connectorId,
    connectorSecret,
    now,
  );
}

export function issueReceiverEnrollment(
  database: SqliteDatabase,
  applicationConnectionId: unknown,
  now?: Date,
): ReceiverEnrollmentIssue {
  return createReceiverConnectionService(database).issue(
    applicationConnectionId,
    now,
  );
}

export function reissueReceiverEnrollment(
  database: SqliteDatabase,
  applicationConnectionId: unknown,
  now?: Date,
): ReceiverEnrollmentIssue {
  return createReceiverConnectionService(database).reissue(
    applicationConnectionId,
    now,
  );
}

export function enrollReceiverConnector(
  database: SqliteDatabase,
  input: unknown,
  now?: Date,
): ReceiverEnrollmentResult {
  return createReceiverConnectionService(database).enroll(input, now);
}

export { RECEIVER_CONNECTOR_PROTOCOL_VERSION, RECEIVER_CAPABILITIES };
