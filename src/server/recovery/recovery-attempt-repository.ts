import {
  RECOVERY_ATTEMPT_STATES,
  type RecoveryAttempt,
  type RecoveryAttemptState,
} from "@/domain/recovery-attempt";
import type { SqliteDatabase } from "@/server/infrastructure/database";

interface RecoveryAttemptRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  state: unknown;
  creationToken: unknown;
  trueForgeSessionId: unknown;
  recoverySpecVersion: unknown;
  sourceRepositoryFullName: unknown;
  originalRevision: unknown;
  providerStatusCode: unknown;
  receiverPreCount: unknown;
  deliveryGuid: unknown;
  trueForgeTurnId: unknown;
  resultJson: unknown;
  patchText: unknown;
  patchSha256: unknown;
  reproductionPreCount: unknown;
  reproductionHttpStatus: unknown;
  reproductionPostCount: unknown;
  verificationPreCount: unknown;
  verificationHttpStatus: unknown;
  verificationPostCount: unknown;
  failureCode: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  verifiedAt: unknown;
}

export interface RecoveryAttemptReservation {
  id: string;
  incidentId: string;
  creationToken: string;
  recoverySpecVersion: string;
  sourceRepositoryFullName: string;
  originalRevision: string;
  providerStatusCode: number;
  receiverPreCount: number;
  deliveryGuid: string;
  createdAt: string;
}

export interface RecoveryAttemptCreationInput
  extends Omit<RecoveryAttemptReservation, "id" | "creationToken" | "createdAt"> {
  id: string;
  creationToken: string;
  createdAt: string;
}

const columns = `
  id,
  incident_id AS incidentId,
  state,
  creation_token AS creationToken,
  trueforge_session_id AS trueForgeSessionId,
  recovery_spec_version AS recoverySpecVersion,
  source_repository_full_name AS sourceRepositoryFullName,
  original_revision AS originalRevision,
  provider_status_code AS providerStatusCode,
  receiver_pre_count AS receiverPreCount,
  delivery_guid AS deliveryGuid,
  trueforge_turn_id AS trueForgeTurnId,
  result_json AS resultJson,
  patch_text AS patchText,
  patch_sha256 AS patchSha256,
  reproduction_pre_count AS reproductionPreCount,
  reproduction_http_status AS reproductionHttpStatus,
  reproduction_post_count AS reproductionPostCount,
  verification_pre_count AS verificationPreCount,
  verification_http_status AS verificationHttpStatus,
  verification_post_count AS verificationPostCount,
  failure_code AS failureCode,
  created_at AS createdAt,
  updated_at AS updatedAt,
  verified_at AS verifiedAt
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Recovery attempt row has an invalid ${field} value.`);
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
    throw new Error(`Recovery attempt row has an invalid ${field} value.`);
  }
  return value;
}

function readInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Recovery attempt row has an invalid ${field} value.`);
  }
  return value as number;
}

function readNullableInteger(
  row: Record<string, unknown>,
  field: string,
): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Recovery attempt row has an invalid ${field} value.`);
  }
  return value as number;
}

function readState(value: unknown): RecoveryAttemptState {
  if (
    typeof value !== "string" ||
    !RECOVERY_ATTEMPT_STATES.includes(value as RecoveryAttemptState)
  ) {
    throw new Error("Recovery attempt row has an invalid state value.");
  }
  return value as RecoveryAttemptState;
}

function mapRow(row: RecoveryAttemptRow): RecoveryAttempt {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    state: readState(row.state),
    creationToken: readNullableText(row, "creationToken"),
    trueForgeSessionId: readNullableText(row, "trueForgeSessionId"),
    recoverySpecVersion: readText(row, "recoverySpecVersion"),
    sourceRepositoryFullName: readText(row, "sourceRepositoryFullName"),
    originalRevision: readText(row, "originalRevision"),
    providerStatusCode: readInteger(row, "providerStatusCode"),
    receiverPreCount: readInteger(row, "receiverPreCount"),
    deliveryGuid: readText(row, "deliveryGuid"),
    trueForgeTurnId: readNullableText(row, "trueForgeTurnId"),
    resultJson: readNullableText(row, "resultJson"),
    patchText: readNullableText(row, "patchText"),
    patchSha256: readNullableText(row, "patchSha256"),
    reproductionPreCount: readNullableInteger(row, "reproductionPreCount"),
    reproductionHttpStatus: readNullableInteger(
      row,
      "reproductionHttpStatus",
    ),
    reproductionPostCount: readNullableInteger(row, "reproductionPostCount"),
    verificationPreCount: readNullableInteger(row, "verificationPreCount"),
    verificationHttpStatus: readNullableInteger(
      row,
      "verificationHttpStatus",
    ),
    verificationPostCount: readNullableInteger(row, "verificationPostCount"),
    failureCode: readNullableText(row, "failureCode"),
    createdAt: readText(row, "createdAt"),
    updatedAt: readText(row, "updatedAt"),
    verifiedAt: readNullableText(row, "verifiedAt"),
  };
}

export function createRecoveryAttemptRepository(database: SqliteDatabase) {
  function getByIncidentId(incidentId: string): RecoveryAttempt | null {
    const row = database.get<RecoveryAttemptRow>(
      `SELECT ${columns} FROM recovery_attempts WHERE incident_id = ?`,
      [incidentId],
    );
    return row === undefined ? null : mapRow(row);
  }

  function reserveCreation(
    input: RecoveryAttemptCreationInput,
  ): RecoveryAttempt {
    return database.transaction(() => {
      const existing = getByIncidentId(input.incidentId);
      if (existing !== null) return existing;

      database.run(
        `
          INSERT INTO recovery_attempts (
            id, incident_id, state, creation_token, trueforge_session_id,
            recovery_spec_version, source_repository_full_name, original_revision,
            provider_status_code, receiver_pre_count, delivery_guid,
            created_at, updated_at
          ) VALUES (
            @id, @incidentId, 'SESSION_CREATING', @creationToken, NULL,
            @recoverySpecVersion, @sourceRepositoryFullName, @originalRevision,
            @providerStatusCode, @receiverPreCount, @deliveryGuid,
            @createdAt, @createdAt
          )
          ON CONFLICT (incident_id) DO NOTHING
        `,
        {
          id: input.id,
          incidentId: input.incidentId,
          creationToken: input.creationToken,
          recoverySpecVersion: input.recoverySpecVersion,
          sourceRepositoryFullName: input.sourceRepositoryFullName,
          originalRevision: input.originalRevision,
          providerStatusCode: input.providerStatusCode,
          receiverPreCount: input.receiverPreCount,
          deliveryGuid: input.deliveryGuid,
          createdAt: input.createdAt,
        },
      );

      const reserved = getByIncidentId(input.incidentId);
      if (reserved === null) {
        throw new Error("Recovery session creation reservation was not persisted.");
      }
      return reserved;
    }, "immediate");
  }

  function activate(
    incidentId: string,
    creationToken: string,
    trueForgeSessionId: string,
    now: string,
  ): RecoveryAttempt | null {
    return database.transaction(() => {
      const updated = database.run(
        `
          UPDATE recovery_attempts
             SET state = 'READY',
                 trueforge_session_id = @trueForgeSessionId,
                 creation_token = NULL,
                 updated_at = @now
           WHERE incident_id = @incidentId
             AND state IN ('SESSION_CREATING', 'SESSION_UNCERTAIN')
             AND trueforge_session_id IS NULL
             AND creation_token = @creationToken
        `,
        { incidentId, creationToken, trueForgeSessionId, now },
      );
      if (updated.changes !== 1) return null;
      return getByIncidentId(incidentId);
    }, "immediate");
  }

  function markCreationUncertain(
    incidentId: string,
    creationToken: string,
    now: string,
  ): boolean {
    return database.transaction(() => {
      const updated = database.run(
        `
          UPDATE recovery_attempts
             SET state = 'SESSION_UNCERTAIN',
                 creation_token = NULL,
                 updated_at = @now
           WHERE incident_id = @incidentId
             AND state = 'SESSION_CREATING'
             AND creation_token = @creationToken
        `,
        { incidentId, creationToken, now },
      );
      return updated.changes === 1;
    }, "immediate");
  }

  function markStaleCreationUncertain(
    incidentId: string,
    creationToken: string,
    expectedCreatedAt: string,
    staleBefore: string,
    now: string,
  ): boolean {
    return database.transaction(() => {
      const updated = database.run(
        `
          UPDATE recovery_attempts
             SET state = 'SESSION_UNCERTAIN',
                 updated_at = @now
           WHERE incident_id = @incidentId
             AND state = 'SESSION_CREATING'
             AND creation_token = @creationToken
             AND created_at = @expectedCreatedAt
             AND created_at <= @staleBefore
        `,
        { incidentId, creationToken, expectedCreatedAt, staleBefore, now },
      );
      return updated.changes === 1;
    }, "immediate");
  }

  function releaseCreation(incidentId: string, creationToken: string): boolean {
    return database.transaction(() => {
      const deleted = database.run(
        `
          DELETE FROM recovery_attempts
           WHERE incident_id = @incidentId
             AND state = 'SESSION_CREATING'
             AND creation_token = @creationToken
        `,
        { incidentId, creationToken },
      );
      return deleted.changes === 1;
    }, "immediate");
  }

  function markRunning(
    incidentId: string,
    trueForgeSessionId: string,
    now: string,
  ): RecoveryAttempt | null {
    return updateState(
      incidentId,
      trueForgeSessionId,
      "READY",
      "RUNNING",
      now,
    );
  }

  function markFailed(
    incidentId: string,
    trueForgeSessionId: string | null,
    failureCode: string,
    now: string,
  ): RecoveryAttempt | null {
    if (trueForgeSessionId === null) {
      const updated = database.run(
        `
          UPDATE recovery_attempts
             SET state = 'FAILED', failure_code = @failureCode, updated_at = @now
           WHERE incident_id = @incidentId
             AND state NOT IN ('REPAIR_VERIFIED', 'SESSION_LOST')
        `,
        { incidentId, failureCode, now },
      );
      return updated.changes === 1 ? getByIncidentId(incidentId) : null;
    }
    return updateState(
      incidentId,
      trueForgeSessionId,
      "RUNNING",
      "FAILED",
      now,
      { failureCode },
    );
  }

  function markSessionLost(
    incidentId: string,
    trueForgeSessionId: string,
    now: string,
  ): RecoveryAttempt | null {
    return updateState(
      incidentId,
      trueForgeSessionId,
      "READY",
      "SESSION_LOST",
      now,
    );
  }

  function updateSpecVersion(
    incidentId: string,
    trueForgeSessionId: string,
    expectedVersion: string,
    nextVersion: string,
    now: string,
  ): RecoveryAttempt | null {
    const updated = database.run(
      `
        UPDATE recovery_attempts
           SET recovery_spec_version = @nextVersion, updated_at = @now
         WHERE incident_id = @incidentId
           AND trueforge_session_id = @trueForgeSessionId
           AND state = 'READY'
           AND recovery_spec_version = @expectedVersion
      `,
      {
        incidentId,
        trueForgeSessionId,
        expectedVersion,
        nextVersion,
        now,
      },
    );
    return updated.changes === 1 ? getByIncidentId(incidentId) : null;
  }

  function markVerified(
    incidentId: string,
    trueForgeSessionId: string,
    turnId: string,
    resultJson: string,
    patchText: string,
    patchSha256: string,
    reproduction: {
      preCount: number;
      httpStatus: number;
      postCount: number;
    },
    verification: {
      preCount: number;
      httpStatus: number;
      postCount: number;
    },
    verifiedAt: string,
  ): RecoveryAttempt | null {
    const updated = database.run(
      `
        UPDATE recovery_attempts
           SET state = 'REPAIR_VERIFIED',
               trueforge_turn_id = @turnId,
               result_json = @resultJson,
               patch_text = @patchText,
               patch_sha256 = @patchSha256,
               reproduction_pre_count = @reproductionPreCount,
               reproduction_http_status = @reproductionHttpStatus,
               reproduction_post_count = @reproductionPostCount,
               verification_pre_count = @verificationPreCount,
               verification_http_status = @verificationHttpStatus,
               verification_post_count = @verificationPostCount,
               failure_code = NULL,
               verified_at = @verifiedAt,
               updated_at = @verifiedAt
         WHERE incident_id = @incidentId
           AND state = 'RUNNING'
           AND trueforge_session_id = @trueForgeSessionId
      `,
      {
        incidentId,
        trueForgeSessionId,
        turnId,
        resultJson,
        patchText,
        patchSha256,
        reproductionPreCount: reproduction.preCount,
        reproductionHttpStatus: reproduction.httpStatus,
        reproductionPostCount: reproduction.postCount,
        verificationPreCount: verification.preCount,
        verificationHttpStatus: verification.httpStatus,
        verificationPostCount: verification.postCount,
        verifiedAt,
      },
    );
    return updated.changes === 1 ? getByIncidentId(incidentId) : null;
  }

  function updateState(
    incidentId: string,
    trueForgeSessionId: string,
    expectedState: RecoveryAttemptState,
    nextState: RecoveryAttemptState,
    now: string,
    additional: { failureCode?: string } = {},
  ): RecoveryAttempt | null {
    const updated = database.run(
      `
        UPDATE recovery_attempts
           SET state = @nextState,
               failure_code = COALESCE(@failureCode, failure_code),
               updated_at = @now
         WHERE incident_id = @incidentId
           AND trueforge_session_id = @trueForgeSessionId
           AND state = @expectedState
      `,
      {
        incidentId,
        trueForgeSessionId,
        expectedState,
        nextState,
        failureCode: additional.failureCode ?? null,
        now,
      },
    );
    return updated.changes === 1 ? getByIncidentId(incidentId) : null;
  }

  return {
    getByIncidentId,
    reserveCreation,
    activate,
    markCreationUncertain,
    markStaleCreationUncertain,
    releaseCreation,
    markRunning,
    markFailed,
    markSessionLost,
    updateSpecVersion,
    markVerified,
  };
}
