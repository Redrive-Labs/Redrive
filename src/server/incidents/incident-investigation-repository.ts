import { randomUUID } from "node:crypto";
import type { SqliteDatabase } from "@/server/infrastructure/database";

export type InvestigationStage = "PROVIDER" | "RECEIVER";
export type InvestigationState =
  | "PROVIDER_CREATING"
  | "PROVIDER_RUNNING"
  | "PROVIDER_UNCERTAIN"
  | "RECEIVER_CREATING"
  | "RECEIVER_RUNNING"
  | "RECEIVER_UNCERTAIN"
  | "COMPLETED"
  | "RETRYABLE_FAILURE";

export interface IncidentInvestigationRecord {
  incidentId: string;
  state: InvestigationState;
  providerOperationToken: string | null;
  providerTurnId: string | null;
  receiverOperationToken: string | null;
  receiverTurnId: string | null;
  failureStage: InvestigationStage | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

interface InvestigationRow extends Record<string, unknown> {
  incidentId: unknown;
  state: unknown;
  providerOperationToken: unknown;
  providerTurnId: unknown;
  receiverOperationToken: unknown;
  receiverTurnId: unknown;
  failureStage: unknown;
  failureCode: unknown;
  createdAt: unknown;
  updatedAt: unknown;
  completedAt: unknown;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Incident investigation row has an invalid ${field}.`);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return text(value, field);
}

function state(value: unknown): InvestigationState {
  if (
    value === "PROVIDER_CREATING" || value === "PROVIDER_RUNNING" ||
    value === "PROVIDER_UNCERTAIN" || value === "RECEIVER_CREATING" ||
    value === "RECEIVER_RUNNING" || value === "RECEIVER_UNCERTAIN" ||
    value === "COMPLETED" || value === "RETRYABLE_FAILURE"
  ) return value;
  throw new Error("Incident investigation row has an invalid state.");
}

function stage(value: unknown): InvestigationStage | null {
  if (value === null || value === undefined) return null;
  if (value === "PROVIDER" || value === "RECEIVER") return value;
  throw new Error("Incident investigation row has an invalid failure stage.");
}

function map(row: InvestigationRow): IncidentInvestigationRecord {
  return {
    incidentId: text(row.incidentId, "incidentId"),
    state: state(row.state),
    providerOperationToken: nullableText(row.providerOperationToken, "providerOperationToken"),
    providerTurnId: nullableText(row.providerTurnId, "providerTurnId"),
    receiverOperationToken: nullableText(row.receiverOperationToken, "receiverOperationToken"),
    receiverTurnId: nullableText(row.receiverTurnId, "receiverTurnId"),
    failureStage: stage(row.failureStage),
    failureCode: nullableText(row.failureCode, "failureCode"),
    createdAt: text(row.createdAt, "createdAt"),
    updatedAt: text(row.updatedAt, "updatedAt"),
    completedAt: nullableText(row.completedAt, "completedAt"),
  };
}

const columns = `
  incident_id AS incidentId,
  state,
  provider_operation_token AS providerOperationToken,
  provider_turn_id AS providerTurnId,
  receiver_operation_token AS receiverOperationToken,
  receiver_turn_id AS receiverTurnId,
  failure_stage AS failureStage,
  failure_code AS failureCode,
  created_at AS createdAt,
  updated_at AS updatedAt,
  completed_at AS completedAt
`;

export function createIncidentInvestigationRepository(
  database: SqliteDatabase,
  now: () => string = () => new Date().toISOString(),
  token: () => string = randomUUID,
) {
  function get(incidentId: string): IncidentInvestigationRecord | null {
    const row = database.get<InvestigationRow>(
      `SELECT ${columns} FROM incident_investigations WHERE incident_id = ?`,
      [incidentId],
    );
    return row === undefined ? null : map(row);
  }

  function insertStage(incidentId: string, target: InvestigationStage): IncidentInvestigationRecord {
    const timestamp = now();
    const providerToken = token();
    const receiverToken = target === "RECEIVER" ? token() : null;
    database.run(
      `INSERT INTO incident_investigations (
        incident_id, state, provider_operation_token, provider_turn_id,
        receiver_operation_token, receiver_turn_id, failure_stage, failure_code,
        created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, NULL)`,
      [
        incidentId,
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        providerToken,
        receiverToken,
        timestamp,
        timestamp,
      ],
    );
    const record = get(incidentId);
    if (record === null) throw new Error("Investigation reservation was not persisted.");
    return record;
  }

  /** Reserve the next missing stage under SQLite IMMEDIATE serialization. */
  function reserve(
    incidentId: string,
    providerCaptured: boolean,
    receiverCaptured: boolean,
  ): { record: IncidentInvestigationRecord; acquired: boolean } {
    return database.transaction(() => {
      const existing = get(incidentId);
      if (providerCaptured && receiverCaptured) {
        const timestamp = now();
        if (existing === null) {
          database.run(
            `INSERT INTO incident_investigations (
              incident_id, state, provider_operation_token, provider_turn_id,
              receiver_operation_token, receiver_turn_id, failure_stage, failure_code,
              created_at, updated_at, completed_at
            ) VALUES (?, 'COMPLETED', NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
            [incidentId, timestamp, timestamp, timestamp],
          );
        } else if (existing.state !== "COMPLETED") {
          database.run(
            `UPDATE incident_investigations
             SET state = 'COMPLETED', failure_stage = NULL, failure_code = NULL,
                 updated_at = ?, completed_at = COALESCE(completed_at, ?)
             WHERE incident_id = ?`,
            [timestamp, timestamp, incidentId],
          );
        }
        return { record: get(incidentId)!, acquired: false };
      }
      if (existing === null) return { record: insertStage(incidentId, providerCaptured ? "RECEIVER" : "PROVIDER"), acquired: true };
      if (
        existing.state === "PROVIDER_CREATING" || existing.state === "PROVIDER_RUNNING" ||
        existing.state === "PROVIDER_UNCERTAIN" || existing.state === "RECEIVER_CREATING" ||
        existing.state === "RECEIVER_RUNNING" || existing.state === "RECEIVER_UNCERTAIN"
      ) return { record: existing, acquired: false };
      if (existing.state === "COMPLETED") {
        throw new Error("Completed investigation is missing authoritative evidence.");
      }
      // A retry is allowed only after a terminal, recorded failure. An
      // ambiguous remote create is represented by *_UNCERTAIN and never takes
      // this path.
      const target: InvestigationStage = providerCaptured ? "RECEIVER" : "PROVIDER";
      const timestamp = now();
      const providerToken = target === "PROVIDER" ? token() : null;
      const receiverToken = target === "RECEIVER" ? token() : null;
      database.run(
        `UPDATE incident_investigations
         SET state = ?, provider_operation_token = CASE WHEN ? = 'PROVIDER' THEN ? ELSE provider_operation_token END,
             provider_turn_id = CASE WHEN ? = 'PROVIDER' THEN NULL ELSE provider_turn_id END,
             receiver_operation_token = ?,
             receiver_turn_id = CASE WHEN ? = 'RECEIVER' THEN NULL ELSE receiver_turn_id END,
             failure_stage = NULL, failure_code = NULL, updated_at = ?
         WHERE incident_id = ?`,
        [
          target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
          target,
          providerToken,
          target,
          receiverToken,
          target,
          timestamp,
          incidentId,
        ],
      );
      return { record: get(incidentId)!, acquired: true };
    }, "immediate");
  }

  function renewCreationLease(incidentId: string, target: InvestigationStage, operationToken: string): boolean {
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    return database.run(
      `UPDATE incident_investigations SET updated_at = ?
       WHERE incident_id = ? AND state = ? AND ${tokenField} = ?`,
      [now(), incidentId, target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING", operationToken],
    ).changes === 1;
  }

  /**
   * Atomically hand the same logical operation from a completed turn to its
   * one permitted serialized corrective turn. The previous turn identity is
   * part of the compare-and-set so a concurrent caller cannot advance a
   * different attempt under this operation token.
   */
  function prepareNextTurn(
    incidentId: string,
    target: InvestigationStage,
    operationToken: string,
    previousTurnId: string,
  ): boolean {
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const turnField = target === "PROVIDER" ? "provider_turn_id" : "receiver_turn_id";
    const result = database.run(
      `UPDATE incident_investigations SET state = ?, updated_at = ?
       WHERE incident_id = ? AND state = ? AND ${tokenField} = ?
         AND ${turnField} = ?`,
      [
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        now(),
        incidentId,
        target === "PROVIDER" ? "PROVIDER_RUNNING" : "RECEIVER_RUNNING",
        operationToken,
        previousTurnId,
      ],
    );
    return result.changes === 1;
  }

  /** Claim a persisted terminal turn for one recovery process to replay. */
  function claimTurnReplay(
    incidentId: string,
    target: InvestigationStage,
    operationToken: string,
    turnId: string,
  ): boolean {
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const turnField = target === "PROVIDER" ? "provider_turn_id" : "receiver_turn_id";
    const result = database.run(
      `UPDATE incident_investigations SET state = ?, updated_at = ?
       WHERE incident_id = ? AND state = ? AND ${tokenField} = ?
         AND ${turnField} = ?`,
      [
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        now(),
        incidentId,
        target === "PROVIDER" ? "PROVIDER_RUNNING" : "RECEIVER_RUNNING",
        operationToken,
        turnId,
      ],
    );
    return result.changes === 1;
  }

  function markTurnCreated(incidentId: string, target: InvestigationStage, operationToken: string, turnId: string): void {
    const timestamp = now();
    const stateValue = target === "PROVIDER" ? "PROVIDER_RUNNING" : "RECEIVER_RUNNING";
    const field = target === "PROVIDER" ? "provider_turn_id" : "receiver_turn_id";
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const result = database.run(
      `UPDATE incident_investigations SET state = ?, ${field} = ?, updated_at = ?
       WHERE incident_id = ? AND (
         state IN (?, ?)
         OR (state = ? AND ${field} = ?)
       ) AND ${tokenField} = ?`,
      [
        stateValue,
        turnId,
        timestamp,
        incidentId,
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        target === "PROVIDER" ? "PROVIDER_UNCERTAIN" : "RECEIVER_UNCERTAIN",
        stateValue,
        turnId,
        operationToken,
      ],
    );
    if (result.changes !== 1) throw new Error("Investigation turn could not be attributed to its reservation.");
  }

  function markUncertainIfStale(
    incidentId: string,
    target: InvestigationStage,
    operationToken: string,
    expectedUpdatedAt: string,
    staleBefore: string,
  ): boolean {
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const result = database.run(
      `UPDATE incident_investigations SET state = ?, updated_at = ?
       WHERE incident_id = ? AND state = ? AND ${tokenField} = ?
         AND updated_at = ? AND updated_at <= ?`,
      [
        target === "PROVIDER" ? "PROVIDER_UNCERTAIN" : "RECEIVER_UNCERTAIN",
        now(),
        incidentId,
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        operationToken,
        expectedUpdatedAt,
        staleBefore,
      ],
    );
    return result.changes === 1;
  }

  function markUncertainAfterCreateAttempt(
    incidentId: string,
    target: InvestigationStage,
    operationToken: string,
  ): void {
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const result = database.run(
      `UPDATE incident_investigations SET state = ?, updated_at = ?
       WHERE incident_id = ? AND state = ? AND ${tokenField} = ?`,
      [
        target === "PROVIDER" ? "PROVIDER_UNCERTAIN" : "RECEIVER_UNCERTAIN",
        now(),
        incidentId,
        target === "PROVIDER" ? "PROVIDER_CREATING" : "RECEIVER_CREATING",
        operationToken,
      ],
    );
    if (result.changes !== 1) throw new Error("Ambiguous turn creation could not be reserved safely.");
  }

  function markRetryableFailure(
    incidentId: string,
    target: InvestigationStage,
    operationToken: string,
    error: unknown,
  ): void {
    const code = error instanceof Error ? error.name : "InvestigationFailure";
    const tokenField = target === "PROVIDER" ? "provider_operation_token" : "receiver_operation_token";
    const result = database.run(
      `UPDATE incident_investigations SET state = 'RETRYABLE_FAILURE',
        failure_stage = ?, failure_code = ?, updated_at = ?
       WHERE incident_id = ? AND ${tokenField} = ?
         AND state NOT IN ('COMPLETED', 'PROVIDER_UNCERTAIN', 'RECEIVER_UNCERTAIN')`,
      [target, code, now(), incidentId, operationToken],
    );
    if (result.changes !== 1) {
      const existing = get(incidentId);
      if (existing?.state !== "RETRYABLE_FAILURE") {
        throw new Error("Investigation failure could not be recorded safely.");
      }
    }
  }

  /** A successful exact marker lookup proved that the ambiguous POST created no turn. */
  function markReconciledAbsent(incidentId: string, target: InvestigationStage): void {
    const result = database.run(
      `UPDATE incident_investigations SET state = 'RETRYABLE_FAILURE',
        failure_stage = ?, failure_code = 'REMOTE_TURN_NOT_FOUND', updated_at = ?
       WHERE incident_id = ? AND state = ?`,
      [
        target,
        now(),
        incidentId,
        target === "PROVIDER" ? "PROVIDER_UNCERTAIN" : "RECEIVER_UNCERTAIN",
      ],
    );
    if (result.changes !== 1) throw new Error("Absent remote turn could not be recorded safely.");
  }

  function markProviderCaptured(incidentId: string, operationToken: string): IncidentInvestigationRecord {
    return database.transaction(() => {
      const timestamp = now();
      const receiverToken = token();
      const result = database.run(
        `UPDATE incident_investigations
         SET state = 'RECEIVER_CREATING', receiver_operation_token = ?,
         failure_stage = NULL, failure_code = NULL, updated_at = ?
         WHERE incident_id = ? AND provider_operation_token = ?
           AND state IN ('PROVIDER_CREATING', 'PROVIDER_RUNNING', 'PROVIDER_UNCERTAIN')`,
        [receiverToken, timestamp, incidentId, operationToken],
      );
      if (result.changes !== 1) {
        const existing = get(incidentId);
        if (existing === null || existing.state !== "RECEIVER_CREATING") {
          throw new Error("Provider evidence could not advance the investigation.");
        }
        return existing;
      }
      return get(incidentId)!;
    }, "immediate");
  }

  function markCompleted(incidentId: string, operationToken: string): void {
    const timestamp = now();
    const result = database.run(
      `UPDATE incident_investigations
       SET state = 'COMPLETED', failure_stage = NULL, failure_code = NULL,
           updated_at = ?, completed_at = ?
       WHERE incident_id = ? AND receiver_operation_token = ?
         AND state IN ('RECEIVER_CREATING', 'RECEIVER_RUNNING', 'RECEIVER_UNCERTAIN')`,
      [timestamp, timestamp, incidentId, operationToken],
    );
    if (result.changes !== 1) {
      const existing = get(incidentId);
      if (existing === null || existing.state !== "COMPLETED") {
        throw new Error("Receiver evidence could not complete the investigation.");
      }
    }
  }

  function backfillCompletedProvenance(
    incidentId: string,
    providerTurnId: string,
    receiverTurnId: string,
  ): void {
    const result = database.run(
      `UPDATE incident_investigations
       SET provider_turn_id = COALESCE(provider_turn_id, ?),
           receiver_turn_id = COALESCE(receiver_turn_id, ?), updated_at = ?
       WHERE incident_id = ? AND state = 'COMPLETED'
         AND (provider_turn_id IS NULL OR provider_turn_id = ?)
         AND (receiver_turn_id IS NULL OR receiver_turn_id = ?)`,
      [providerTurnId, receiverTurnId, now(), incidentId, providerTurnId, receiverTurnId],
    );
    if (result.changes !== 1) throw new Error("Completed investigation provenance could not be backfilled safely.");
  }

  return { get, reserve, renewCreationLease, prepareNextTurn, claimTurnReplay, markTurnCreated, markUncertainIfStale, markUncertainAfterCreateAttempt, markRetryableFailure, markReconciledAbsent, markProviderCaptured, markCompleted, backfillCompletedProvenance };
}
