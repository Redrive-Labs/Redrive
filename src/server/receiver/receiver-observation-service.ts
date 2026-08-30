import { randomUUID } from "node:crypto";
import {
  parseBusinessStateReadResult,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";
import {
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
} from "@/agents/recovery-coordinator";
import {
  RECEIVER_OBSERVATION_TOOL,
  type ReceiverObservation,
} from "@/domain/receiver-observation";
import type { SqliteDatabase } from "@/server/infrastructure/database";
import { createIncidentService } from "@/server/incidents/incident-service";
import { createTrueForgeSessionBindingRepository } from "@/server/trueforge/trueforge-session-binding-repository";

export type ReceiverObservationDisposition = "CAPTURED" | "REPLAYED";

export interface AppendReceiverObservationInput {
  incidentId: string;
  applicationConnectionId: string;
  deliveryGuid: string;
  capability: unknown;
  tool: unknown;
  mcpServerName: string;
  result: unknown;
  trueForgeSessionId: string;
  turnId: string;
  receiverInvestigatorThreadId: string;
  threadCreatedEventId: string;
  toolCallId: string;
  toolCallEventId: string;
  toolResponseEventId: string;
  toolResponseCreatedAt: string;
  createdAt?: string;
}

export interface ReceiverObservationCaptureResult {
  observation: ReceiverObservation;
  disposition: ReceiverObservationDisposition;
}

export class ReceiverObservationProvenanceConflictError extends Error {
  readonly existing: ReceiverObservation | null;
  readonly attempted: Readonly<ReceiverObservationAttempt>;

  constructor(
    message: string,
    existing: ReceiverObservation | null,
    attempted: ReceiverObservationAttempt,
  ) {
    super(message);
    this.name = "ReceiverObservationProvenanceConflictError";
    this.existing = existing;
    this.attempted = attempted;
  }
}

export class ReceiverObservationSessionBindingError extends Error {
  constructor(message: string) {
    super(`Receiver observation session binding failed: ${message}`);
    this.name = "ReceiverObservationSessionBindingError";
  }
}

interface ReceiverObservationAttempt {
  incidentId: string;
  applicationConnectionId: string;
  deliveryGuid: string;
  capability: typeof RECEIVER_CAPABILITY_BUSINESS_STATE;
  tool: typeof RECEIVER_OBSERVATION_TOOL;
  mcpServerName: string;
  mutationCount: number;
  businessState: BusinessStateReadResult["businessState"];
  observedAt: string;
  trueForgeSessionId: string;
  turnId: string;
  receiverInvestigatorThreadId: string;
  threadCreatedEventId: string;
  toolCallId: string;
  toolCallEventId: string;
  toolResponseEventId: string;
  toolResponseCreatedAt: string;
}

interface ReceiverObservationRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  applicationConnectionId: unknown;
  deliveryGuid: unknown;
  capability: unknown;
  tool: unknown;
  mcpServerName: unknown;
  mutationCount: unknown;
  businessState: unknown;
  observedAt: unknown;
  trueForgeSessionId: unknown;
  turnId: unknown;
  receiverInvestigatorThreadId: unknown;
  threadCreatedEventId: unknown;
  toolCallId: unknown;
  toolCallEventId: unknown;
  toolResponseEventId: unknown;
  toolResponseCreatedAt: unknown;
  observationJson: unknown;
  createdAt: unknown;
}

const receiverObservationColumns = `
  id,
  incident_id AS incidentId,
  application_connection_id AS applicationConnectionId,
  delivery_guid AS deliveryGuid,
  capability,
  tool,
  mcp_server_name AS mcpServerName,
  mutation_count AS mutationCount,
  business_state AS businessState,
  observed_at AS observedAt,
  trueforge_session_id AS trueForgeSessionId,
  turn_id AS turnId,
  receiver_investigator_thread_id AS receiverInvestigatorThreadId,
  thread_created_event_id AS threadCreatedEventId,
  tool_call_id AS toolCallId,
  tool_call_event_id AS toolCallEventId,
  tool_response_event_id AS toolResponseEventId,
  tool_response_created_at AS toolResponseCreatedAt,
  observation_json AS observationJson,
  created_at AS createdAt
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Receiver observation row has an invalid ${field} value.`);
  }
  return value;
}

function readNonEmptyInput(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Receiver observation ${field} must be a non-empty string.`);
  }
  return value;
}

function readInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`Receiver observation row has an invalid ${field} value.`);
  }
  return value;
}

function readCapability(value: unknown): typeof RECEIVER_CAPABILITY_BUSINESS_STATE {
  if (value !== RECEIVER_CAPABILITY_BUSINESS_STATE) {
    throw new Error("Receiver observation row has an invalid capability.");
  }
  return RECEIVER_CAPABILITY_BUSINESS_STATE;
}

function readTool(value: unknown): typeof RECEIVER_OBSERVATION_TOOL {
  if (value !== RECEIVER_OBSERVATION_TOOL) {
    throw new Error("Receiver observation row has an invalid tool.");
  }
  return RECEIVER_OBSERVATION_TOOL;
}

function parseStoredResult(
  row: ReceiverObservationRow,
  deliveryGuid: string,
): BusinessStateReadResult {
  const observationJson = readText(row, "observationJson");
  let parsed: unknown;
  try {
    parsed = JSON.parse(observationJson) as unknown;
  } catch {
    throw new Error("Receiver observation row contains invalid JSON.");
  }
  return parseBusinessStateReadResult(parsed, deliveryGuid);
}

function mapReceiverObservationRow(
  row: ReceiverObservationRow,
  expectedIncidentId?: string,
): ReceiverObservation {
  const incidentId = readText(row, "incidentId");
  if (expectedIncidentId !== undefined && incidentId !== expectedIncidentId) {
    throw new Error("Receiver observation row has an invalid incident ID.");
  }

  const deliveryGuid = readText(row, "deliveryGuid");
  const capability = readCapability(row.capability);
  const tool = readTool(row.tool);
  const result = parseStoredResult(row, deliveryGuid);
  const mutationCount = readInteger(row, "mutationCount");
  const businessState = readText(row, "businessState");

  if (
    mutationCount !== result.mutationCount ||
    businessState !== result.businessState ||
    row.observedAt !== result.observedAt
  ) {
    throw new Error(
      "Receiver observation row does not match its normalized JSON.",
    );
  }

  return {
    id: readText(row, "id"),
    incidentId,
    applicationConnectionId: readText(row, "applicationConnectionId"),
    deliveryGuid,
    capability,
    tool,
    mcpServerName: readText(row, "mcpServerName"),
    mutationCount,
    businessState: result.businessState,
    observedAt: result.observedAt,
    trueForgeSessionId: readText(row, "trueForgeSessionId"),
    turnId: readText(row, "turnId"),
    receiverInvestigatorThreadId: readText(
      row,
      "receiverInvestigatorThreadId",
    ),
    threadCreatedEventId: readText(row, "threadCreatedEventId"),
    toolCallId: readText(row, "toolCallId"),
    toolCallEventId: readText(row, "toolCallEventId"),
    toolResponseEventId: readText(row, "toolResponseEventId"),
    toolResponseCreatedAt: readText(row, "toolResponseCreatedAt"),
    createdAt: readText(row, "createdAt"),
  };
}

function getRowById(
  database: SqliteDatabase,
  id: string,
): ReceiverObservationRow | undefined {
  return database.get<ReceiverObservationRow>(
    `SELECT ${receiverObservationColumns}
       FROM receiver_observations
      WHERE id = ?`,
    [id],
  );
}

function getRowsByToolResponseEventId(
  database: SqliteDatabase,
  eventId: string,
): ReceiverObservationRow[] {
  return database.all<ReceiverObservationRow>(
    `SELECT ${receiverObservationColumns}
       FROM receiver_observations
      WHERE tool_response_event_id = ?`,
    [eventId],
  );
}

function getRowBySessionAndToolResponseEventId(
  database: SqliteDatabase,
  sessionId: string,
  eventId: string,
): ReceiverObservationRow | undefined {
  return database.get<ReceiverObservationRow>(
    `SELECT ${receiverObservationColumns}
       FROM receiver_observations
      WHERE trueforge_session_id = ? AND tool_response_event_id = ?`,
    [sessionId, eventId],
  );
}

function getRowBySessionAndTurn(
  database: SqliteDatabase,
  sessionId: string,
  turnId: string,
): ReceiverObservationRow | undefined {
  return database.get<ReceiverObservationRow>(
    `SELECT ${receiverObservationColumns}
       FROM receiver_observations
      WHERE trueforge_session_id = ? AND turn_id = ?`,
    [sessionId, turnId],
  );
}

function sameAttempt(
  existing: ReceiverObservation,
  attempted: ReceiverObservationAttempt,
): boolean {
  return (
    existing.incidentId === attempted.incidentId &&
    existing.applicationConnectionId === attempted.applicationConnectionId &&
    existing.deliveryGuid === attempted.deliveryGuid &&
    existing.capability === attempted.capability &&
    existing.tool === attempted.tool &&
    existing.mcpServerName === attempted.mcpServerName &&
    existing.mutationCount === attempted.mutationCount &&
    existing.businessState === attempted.businessState &&
    existing.observedAt === attempted.observedAt &&
    existing.trueForgeSessionId === attempted.trueForgeSessionId &&
    existing.turnId === attempted.turnId &&
    existing.receiverInvestigatorThreadId ===
      attempted.receiverInvestigatorThreadId &&
    existing.threadCreatedEventId === attempted.threadCreatedEventId &&
    existing.toolCallId === attempted.toolCallId &&
    existing.toolCallEventId === attempted.toolCallEventId &&
    existing.toolResponseEventId === attempted.toolResponseEventId &&
    existing.toolResponseCreatedAt === attempted.toolResponseCreatedAt
  );
}

function makeAttempt(
  input: AppendReceiverObservationInput,
  result: BusinessStateReadResult,
): ReceiverObservationAttempt {
  if (input.capability !== RECEIVER_CAPABILITY_BUSINESS_STATE) {
    throw new Error("Receiver observation capability is unsupported.");
  }
  if (input.tool !== RECEIVER_OBSERVATION_TOOL) {
    throw new Error("Receiver observation tool is unsupported.");
  }

  return {
    incidentId: readNonEmptyInput(input.incidentId, "incidentId"),
    applicationConnectionId: readNonEmptyInput(
      input.applicationConnectionId,
      "applicationConnectionId",
    ),
    deliveryGuid: readNonEmptyInput(input.deliveryGuid, "deliveryGuid"),
    capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
    tool: RECEIVER_OBSERVATION_TOOL,
    mcpServerName: readNonEmptyInput(input.mcpServerName, "mcpServerName"),
    mutationCount: result.mutationCount,
    businessState: result.businessState,
    observedAt: result.observedAt,
    trueForgeSessionId: readNonEmptyInput(
      input.trueForgeSessionId,
      "trueForgeSessionId",
    ),
    turnId: readNonEmptyInput(input.turnId, "turnId"),
    receiverInvestigatorThreadId: readNonEmptyInput(
      input.receiverInvestigatorThreadId,
      "receiverInvestigatorThreadId",
    ),
    threadCreatedEventId: readNonEmptyInput(
      input.threadCreatedEventId,
      "threadCreatedEventId",
    ),
    toolCallId: readNonEmptyInput(input.toolCallId, "toolCallId"),
    toolCallEventId: readNonEmptyInput(
      input.toolCallEventId,
      "toolCallEventId",
    ),
    toolResponseEventId: readNonEmptyInput(
      input.toolResponseEventId,
      "toolResponseEventId",
    ),
    toolResponseCreatedAt: readNonEmptyInput(
      input.toolResponseCreatedAt,
      "toolResponseCreatedAt",
    ),
  };
}

function conflict(
  existing: ReceiverObservation | null,
  attempted: ReceiverObservationAttempt,
  message: string,
): ReceiverObservationProvenanceConflictError {
  return new ReceiverObservationProvenanceConflictError(
    message,
    existing,
    attempted,
  );
}

export function createReceiverObservationService(
  database: SqliteDatabase,
  now: () => string = () => new Date().toISOString(),
) {
  const incidentService = createIncidentService(database);
  const sessionBindingRepository = createTrueForgeSessionBindingRepository(
    database,
  );

  function getById(id: string): ReceiverObservation | null {
    const row = getRowById(database, id);
    return row === undefined ? null : mapReceiverObservationRow(row);
  }

  function getByToolResponseEventId(eventId: string): ReceiverObservation | null {
    const rows = getRowsByToolResponseEventId(database, eventId);
    if (rows.length > 1) {
      throw new Error(
        "Receiver observation response provenance is ambiguous without a TrueForge session.",
      );
    }
    return rows.length === 0 ? null : mapReceiverObservationRow(rows[0]);
  }

  function getBySessionAndToolResponseEventId(
    sessionId: string,
    eventId: string,
  ): ReceiverObservation | null {
    const row = getRowBySessionAndToolResponseEventId(
      database,
      sessionId,
      eventId,
    );
    return row === undefined ? null : mapReceiverObservationRow(row);
  }

  function getBySessionAndTurn(
    sessionId: string,
    turnId: string,
  ): ReceiverObservation | null {
    const row = getRowBySessionAndTurn(database, sessionId, turnId);
    return row === undefined ? null : mapReceiverObservationRow(row);
  }

  function listByIncidentId(incidentId: string): ReceiverObservation[] {
    return database
      .all<ReceiverObservationRow>(
        `SELECT ${receiverObservationColumns}
           FROM receiver_observations
          WHERE incident_id = ?
          ORDER BY created_at ASC, id ASC`,
        [incidentId],
      )
      .map((row) => mapReceiverObservationRow(row, incidentId));
  }

  function appendWithinTransaction(
    input: AppendReceiverObservationInput,
  ): ReceiverObservationCaptureResult {
    const deliveryGuid = readNonEmptyInput(input.deliveryGuid, "deliveryGuid");
    const result = parseBusinessStateReadResult(input.result, deliveryGuid);
    const attempted = makeAttempt(input, result);
    const incident = incidentService.getById(attempted.incidentId);
    if (incident === null) {
      throw conflict(
        null,
        attempted,
        "The receiver observation incident does not exist.",
      );
    }
    if (incident.applicationConnectionId !== attempted.applicationConnectionId) {
      throw conflict(
        null,
        attempted,
        "The receiver observation connection does not match the incident.",
      );
    }

    const binding = sessionBindingRepository.getByIncidentId(
      attempted.incidentId,
    );
    if (binding === null) {
      throw new ReceiverObservationSessionBindingError(
        "the incident has no durable TrueForge session binding.",
      );
    }
    if (
      binding.state !== "ACTIVE" ||
      binding.trueForgeSessionId === null
    ) {
      throw new ReceiverObservationSessionBindingError(
        "the incident TrueForge session binding is not ACTIVE.",
      );
    }
    if (binding.trueForgeSessionId !== attempted.trueForgeSessionId) {
      throw new ReceiverObservationSessionBindingError(
        "the observation session ID does not match the incident binding.",
      );
    }
    if (
      binding.coordinatorSpecVersion !==
      CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION
    ) {
      throw new ReceiverObservationSessionBindingError(
        "the incident TrueForge session binding does not use the current supported Coordinator spec.",
      );
    }

    const existingResponseRow = getRowBySessionAndToolResponseEventId(
      database,
      attempted.trueForgeSessionId,
      attempted.toolResponseEventId,
    );
    if (existingResponseRow !== undefined) {
      const existing = mapReceiverObservationRow(existingResponseRow);
      if (sameAttempt(existing, attempted)) {
        return { observation: existing, disposition: "REPLAYED" };
      }
      throw conflict(
        existing,
        attempted,
        "The receiver response event conflicts with durable provenance.",
      );
    }

    const existingTurnRow = getRowBySessionAndTurn(
      database,
      attempted.trueForgeSessionId,
      attempted.turnId,
    );
    if (existingTurnRow !== undefined) {
      throw conflict(
        mapReceiverObservationRow(existingTurnRow),
        attempted,
        "The receiver investigation turn already has a different observation.",
      );
    }

    const observationJson = JSON.stringify(result);
    if (observationJson === undefined) {
      throw new Error("Receiver observation could not be serialized.");
    }
    const id = randomUUID();
    const createdAt = input.createdAt ?? now();
    readNonEmptyInput(createdAt, "createdAt");

    const insertion = database.run(
      `
        INSERT INTO receiver_observations (
          id,
          incident_id,
          application_connection_id,
          delivery_guid,
          capability,
          tool,
          mcp_server_name,
          mutation_count,
          business_state,
          observed_at,
          trueforge_session_id,
          turn_id,
          receiver_investigator_thread_id,
          thread_created_event_id,
          tool_call_id,
          tool_call_event_id,
          tool_response_event_id,
          tool_response_created_at,
          observation_json,
          created_at
        ) VALUES (
          @id,
          @incidentId,
          @applicationConnectionId,
          @deliveryGuid,
          @capability,
          @tool,
          @mcpServerName,
          @mutationCount,
          @businessState,
          @observedAt,
          @trueForgeSessionId,
          @turnId,
          @receiverInvestigatorThreadId,
          @threadCreatedEventId,
          @toolCallId,
          @toolCallEventId,
          @toolResponseEventId,
          @toolResponseCreatedAt,
          @observationJson,
          @createdAt
        )
        ON CONFLICT DO NOTHING
      `,
      {
        id,
        ...attempted,
        observationJson,
        createdAt,
      },
    );

    if (insertion.changes !== 1) {
      const replayedRow = getRowBySessionAndToolResponseEventId(
        database,
        attempted.trueForgeSessionId,
        attempted.toolResponseEventId,
      );
      if (replayedRow !== undefined) {
        const replayed = mapReceiverObservationRow(replayedRow);
        if (sameAttempt(replayed, attempted)) {
          return { observation: replayed, disposition: "REPLAYED" };
        }
        throw conflict(
          replayed,
          attempted,
          "The receiver response event conflicts with durable provenance.",
        );
      }

      const conflictingTurnRow = getRowBySessionAndTurn(
        database,
        attempted.trueForgeSessionId,
        attempted.turnId,
      );
      if (conflictingTurnRow !== undefined) {
        throw conflict(
          mapReceiverObservationRow(conflictingTurnRow),
          attempted,
          "The receiver investigation turn already has a different observation.",
        );
      }
      throw new Error("Receiver observation insert did not produce a row.");
    }

    const persistedRow = getRowById(database, id);
    if (persistedRow === undefined) {
      throw new Error("Receiver observation insert did not produce a row.");
    }
    const observation = mapReceiverObservationRow(persistedRow);
    if (!sameAttempt(observation, attempted)) {
      throw new Error("Receiver observation insert changed its normalized data.");
    }
    return { observation, disposition: "CAPTURED" };
  }

  function append(
    input: AppendReceiverObservationInput,
  ): ReceiverObservationCaptureResult {
    return database.transaction(
      () => appendWithinTransaction(input),
      "immediate",
    );
  }

  return {
    getById,
    getByToolResponseEventId,
    getBySessionAndToolResponseEventId,
    getBySessionAndTurn,
    listByIncidentId,
    append,
    appendWithinTransaction,
  };
}
