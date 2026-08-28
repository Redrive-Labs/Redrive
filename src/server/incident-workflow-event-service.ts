import { randomUUID } from "node:crypto";
import {
  INCIDENT_WORKFLOW_EVENT_TYPES,
  type IncidentWorkflowEvent,
  type IncidentWorkflowEventDetails,
  type IncidentWorkflowEventType,
} from "@/domain/incident-workflow-event";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";

interface IncidentWorkflowEventRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  eventType: unknown;
  trueForgeSessionId: unknown;
  turnId: unknown;
  providerInvestigatorThreadId: unknown;
  trueForgeEventId: unknown;
  toolCallId: unknown;
  occurredAt: unknown;
  detailsJson: unknown;
}

const workflowEventColumns = `
  id,
  incident_id AS incidentId,
  event_type AS eventType,
  trueforge_session_id AS trueForgeSessionId,
  turn_id AS turnId,
  provider_investigator_thread_id AS providerInvestigatorThreadId,
  trueforge_event_id AS trueForgeEventId,
  tool_call_id AS toolCallId,
  occurred_at AS occurredAt,
  details_json AS detailsJson
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Incident workflow event row has an invalid ${field} value.`);
  }
  return value;
}

function readNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value !== null && (typeof value !== "string" || value.length === 0)) {
    throw new Error(`Incident workflow event row has an invalid ${field} value.`);
  }
  return value;
}

function readEventType(value: unknown): IncidentWorkflowEventType {
  if (
    typeof value !== "string" ||
    !INCIDENT_WORKFLOW_EVENT_TYPES.includes(value as IncidentWorkflowEventType)
  ) {
    throw new Error("Incident workflow event row has an invalid event type.");
  }
  return value as IncidentWorkflowEventType;
}

function readDetails(row: IncidentWorkflowEventRow): Record<string, unknown> {
  const detailsJson = readText(row, "detailsJson");
  let parsed: unknown;
  try {
    parsed = JSON.parse(detailsJson) as unknown;
  } catch {
    throw new Error("Incident workflow event row contains invalid details JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Incident workflow event details must be an object.");
  }
  return parsed as Record<string, unknown>;
}

function mapWorkflowEventRow(row: IncidentWorkflowEventRow): IncidentWorkflowEvent {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    eventType: readEventType(row.eventType),
    trueForgeSessionId: readNullableText(row, "trueForgeSessionId"),
    turnId: readNullableText(row, "turnId"),
    providerInvestigatorThreadId: readNullableText(
      row,
      "providerInvestigatorThreadId",
    ),
    trueForgeEventId: readNullableText(row, "trueForgeEventId"),
    toolCallId: readNullableText(row, "toolCallId"),
    occurredAt: readText(row, "occurredAt"),
    details: readDetails(row),
  };
}

function assertScalarDetails(details: IncidentWorkflowEventDetails): void {
  for (const [key, value] of Object.entries(details)) {
    if (
      value !== null &&
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      (typeof value !== "number" || !Number.isFinite(value))
    ) {
      throw new Error(
        `Incident workflow event detail ${key} must be a finite scalar value.`,
      );
    }
  }
}

export interface AppendIncidentWorkflowEventInput {
  incidentId: string;
  eventType: IncidentWorkflowEventType;
  trueForgeSessionId?: string | null;
  turnId?: string | null;
  providerInvestigatorThreadId?: string | null;
  trueForgeEventId?: string | null;
  toolCallId?: string | null;
  occurredAt?: string;
  details?: IncidentWorkflowEventDetails;
}

export function createIncidentWorkflowEventService(
  database: SqliteDatabase,
  now: () => string = () => new Date().toISOString(),
) {
  function getById(id: string): IncidentWorkflowEvent | null {
    const row = database.get<IncidentWorkflowEventRow>(
      `
        SELECT ${workflowEventColumns}
        FROM incident_workflow_events
        WHERE id = ?
      `,
      [id],
    );
    return row === undefined ? null : mapWorkflowEventRow(row);
  }

  function getByTrueForgeEventId(
    trueForgeEventId: string,
  ): IncidentWorkflowEvent | null {
    const row = database.get<IncidentWorkflowEventRow>(
      `
        SELECT ${workflowEventColumns}
        FROM incident_workflow_events
        WHERE trueforge_event_id = ?
      `,
      [trueForgeEventId],
    );
    return row === undefined ? null : mapWorkflowEventRow(row);
  }

  function listByIncidentId(incidentId: string): IncidentWorkflowEvent[] {
    return database
      .all<IncidentWorkflowEventRow>(
        `
          SELECT ${workflowEventColumns}
          FROM incident_workflow_events
          WHERE incident_id = ?
          ORDER BY occurred_at ASC, id ASC
        `,
        [incidentId],
      )
      .map(mapWorkflowEventRow);
  }

  function append(
    input: AppendIncidentWorkflowEventInput,
  ): IncidentWorkflowEvent {
    if (!INCIDENT_WORKFLOW_EVENT_TYPES.includes(input.eventType)) {
      throw new Error("Incident workflow event type is not supported.");
    }

    const details = input.details ?? {};
    assertScalarDetails(details);
    const detailsJson = JSON.stringify(details);
    if (detailsJson === undefined) {
      throw new Error("Incident workflow event details could not be serialized.");
    }

    const id = randomUUID();
    const trueForgeEventId = input.trueForgeEventId ?? null;
    const persistedId = database.transaction(() => {
      const insertion = database.run(
        `
          INSERT INTO incident_workflow_events (
            id,
            incident_id,
            event_type,
            trueforge_session_id,
            turn_id,
            provider_investigator_thread_id,
            trueforge_event_id,
            tool_call_id,
            occurred_at,
            details_json
          ) VALUES (
            @id,
            @incidentId,
            @eventType,
            @trueForgeSessionId,
            @turnId,
            @providerInvestigatorThreadId,
            @trueForgeEventId,
            @toolCallId,
            @occurredAt,
            @detailsJson
          )
          ON CONFLICT (trueforge_event_id) DO NOTHING
        `,
        {
          id,
          incidentId: input.incidentId,
          eventType: input.eventType,
          trueForgeSessionId: input.trueForgeSessionId ?? null,
          turnId: input.turnId ?? null,
          providerInvestigatorThreadId:
            input.providerInvestigatorThreadId ?? null,
          trueForgeEventId,
          toolCallId: input.toolCallId ?? null,
          occurredAt: input.occurredAt ?? now(),
          detailsJson,
        },
      );

      if (insertion.changes === 1) {
        return id;
      }

      if (trueForgeEventId === null) {
        throw new Error("Incident workflow event insert did not persist.");
      }

      const existing = database.get<{ id: string; incident_id: string }>(
        "SELECT id, incident_id FROM incident_workflow_events WHERE trueforge_event_id = ?",
        [trueForgeEventId],
      );
      if (existing === undefined) {
        throw new Error("Incident workflow event idempotency lookup failed.");
      }
      if (existing.incident_id !== input.incidentId) {
        throw new Error(
          "TrueForge event id is already attributed to a different incident.",
        );
      }
      return existing.id;
    }, "immediate");

    const persisted = getById(persistedId);
    if (persisted === null) {
      throw new Error("Incident workflow event was not persisted.");
    }
    return persisted;
  }

  return {
    append,
    getById,
    getByTrueForgeEventId,
    listByIncidentId,
  };
}

type IncidentWorkflowEventService = ReturnType<
  typeof createIncidentWorkflowEventService
>;

function withConfiguredService<T>(
  operation: (service: IncidentWorkflowEventService) => T,
): T {
  return operation(
    createIncidentWorkflowEventService(
      getConfiguredDatabase(getServerConfig().databasePath),
    ),
  );
}

export function getIncidentWorkflowEvents(
  incidentId: string,
): IncidentWorkflowEvent[] {
  return withConfiguredService((service) => service.listByIncidentId(incidentId));
}
