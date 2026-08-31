import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION } from "@/agents/recovery-coordinator";
import { createIncidentService } from "@/server/incidents/incident-service";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import {
  createReceiverObservationService,
  ReceiverObservationProvenanceConflictError,
  type AppendReceiverObservationInput,
} from "@/server/receiver/receiver-observation-service";

const applicationConnectionId = "application-connection-1";
const deliveryGuid = "delivery-guid-1";
const now = "2026-08-30T00:00:00.000Z";

function createConnection(database: SqliteDatabase): void {
  database.run(
    `INSERT INTO github_app_registrations
      (id, github_app_id, slug, owner_id, owner_login, owner_type,
       private_key_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["app-1", "app-id", "redrive", "owner-id", "octocat", "User", "key", now, now],
  );
  database.run(
    `INSERT INTO github_installations
      (installation_id, app_registration_id, account_id, account_login,
       account_type, repository_selection, last_verified_at, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ["installation-1", "app-1", "owner-id", "octocat", "User", "selected", now, now, now],
  );
  database.run(
    `INSERT INTO application_connections
      (id, provider, github_installation_id, repository_id,
       repository_full_name, webhook_id, webhook_target_display, state,
       created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      applicationConnectionId,
      "github",
      "installation-1",
      "repository-1",
      "octocat/receiver",
      "webhook-1",
      "https://receiver.example/webhook",
      "READY",
      now,
      now,
    ],
  );
}

function createIncident(
  database: SqliteDatabase,
  bindSession = true,
  sessionId = "session-1",
): string {
  const incident = createIncidentService(database).create({
    provider: "github",
    externalDeliveryId: `provider-delivery-${crypto.randomUUID()}`,
    repositoryId: "octocat/receiver",
  }).incident;
  database.run(
    "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
    [applicationConnectionId, incident.id],
  );
  if (bindSession) {
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token,
         coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, ?, ?, ?)`,
      [
        incident.id,
        sessionId,
        CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
        now,
        now,
      ],
    );
  }
  return incident.id;
}

function appendInput(incidentId: string, suffix = "1"): AppendReceiverObservationInput {
  return {
    incidentId,
    applicationConnectionId,
    deliveryGuid,
    capability: "business_state:v1",
    tool: "get_business_state",
    mcpServerName: "redrive-receiver",
    result: {
      schemaVersion: 1,
      deliveryGuid,
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      observedAt: now,
    },
    trueForgeSessionId: "session-1",
    turnId: `receiver-turn-${suffix}`,
    receiverInvestigatorThreadId: `receiver-thread-${suffix}`,
    threadCreatedEventId: `thread-created-${suffix}`,
    toolCallId: `tool-call-${suffix}`,
    toolCallEventId: `tool-call-event-${suffix}`,
    toolResponseEventId: `tool-response-event-${suffix}`,
    toolResponseCreatedAt: now,
    createdAt: now,
  };
}

describe("ReceiverObservation persistence", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-receiver-observation-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
    createConnection(database);
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  it("appends an immutable normalized observation with complete provenance", () => {
    const incidentId = createIncident(database);
    const service = createReceiverObservationService(database, () => now);

    const captured = service.append(appendInput(incidentId));

    expect(captured.disposition).toBe("CAPTURED");
    expect(captured.observation).toMatchObject({
      incidentId,
      applicationConnectionId,
      deliveryGuid,
      capability: "business_state:v1",
      tool: "get_business_state",
      mutationCount: 1,
      businessState: "EXACTLY_ONE",
      trueForgeSessionId: "session-1",
      turnId: "receiver-turn-1",
      toolResponseEventId: "tool-response-event-1",
    });
    expect(service.listByIncidentId(incidentId)).toHaveLength(1);
    expect("update" in service).toBe(false);
    expect("delete" in service).toBe(false);
  });

  it("replays the exact response event only when semantic data and provenance match", () => {
    const incidentId = createIncident(database);
    const service = createReceiverObservationService(database, () => now);
    const input = appendInput(incidentId);

    const first = service.append(input);
    const replay = service.append({ ...input, createdAt: "2026-08-30T00:01:00.000Z" });

    expect(replay).toEqual({
      disposition: "REPLAYED",
      observation: first.observation,
    });
    expect(service.listByIncidentId(incidentId)).toHaveLength(1);

    expect(() =>
      service.append({
        ...input,
        result: {
          schemaVersion: 1,
          deliveryGuid,
          mutationCount: 0,
          businessState: "ABSENT",
          observedAt: now,
        },
      }),
    ).toThrow(ReceiverObservationProvenanceConflictError);
  });

  it("rejects reused response provenance in a different turn of the same session", () => {
    const incidentId = createIncident(database);
    const service = createReceiverObservationService(database, () => now);
    const first = service.append(appendInput(incidentId, "1"));

    expect(() =>
      service.append({
        ...appendInput(incidentId, "2"),
        toolResponseEventId: first.observation.toolResponseEventId,
      }),
    ).toThrow(ReceiverObservationProvenanceConflictError);
    expect(service.listByIncidentId(incidentId)).toHaveLength(1);
  });

  it("accepts a later turn as a new append-only observation", () => {
    const incidentId = createIncident(database);
    const service = createReceiverObservationService(database, () => now);

    service.append(appendInput(incidentId, "1"));
    const second = service.append(appendInput(incidentId, "2"));

    expect(second.disposition).toBe("CAPTURED");
    expect(service.listByIncidentId(incidentId)).toHaveLength(2);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations WHERE incident_id = ? AND delivery_guid = ?",
        [incidentId, deliveryGuid],
      ),
    ).toEqual({ count: 2 });
  });

  it("allows the same response event label in another session because identity is session-scoped", () => {
    const firstIncidentId = createIncident(database, true, "session-1");
    const secondIncidentId = createIncident(database, true, "session-2");
    const service = createReceiverObservationService(database, () => now);
    const first = service.append(appendInput(firstIncidentId));

    const second = service.append({
      ...appendInput(secondIncidentId),
      trueForgeSessionId: "session-2",
    });

    expect(first.disposition).toBe("CAPTURED");
    expect(second.disposition).toBe("CAPTURED");
    expect(second.observation.toolResponseEventId).toBe(
      first.observation.toolResponseEventId,
    );
  });

  it("rejects an observation without a durable active session binding", () => {
    const incidentId = createIncident(database, false);
    const service = createReceiverObservationService(database, () => now);

    expect(() => service.append(appendInput(incidentId))).toThrow(
      "no durable TrueForge session binding",
    );
    expect(service.listByIncidentId(incidentId)).toEqual([]);
  });

  it("rejects a session binding from another incident", () => {
    const firstIncidentId = createIncident(database, true, "session-1");
    const secondIncidentId = createIncident(database, true, "session-2");
    const service = createReceiverObservationService(database, () => now);

    expect(() =>
      service.append({
        ...appendInput(firstIncidentId),
        trueForgeSessionId: "session-2",
        turnId: "receiver-turn-cross-incident",
      }),
    ).toThrow("does not match the incident binding");
    expect(service.listByIncidentId(firstIncidentId)).toEqual([]);
    expect(service.listByIncidentId(secondIncidentId)).toEqual([]);
  });

  it("rejects a LOST binding before writing provenance", () => {
    const incidentId = createIncident(database);
    database.run(
      "UPDATE trueforge_session_bindings SET state = 'LOST' WHERE incident_id = ?",
      [incidentId],
    );
    const service = createReceiverObservationService(database, () => now);

    expect(() => service.append(appendInput(incidentId))).toThrow(
      "binding is not ACTIVE",
    );
    expect(service.listByIncidentId(incidentId)).toEqual([]);
  });

  it("rejects a prior Coordinator spec at the observation boundary", () => {
    const incidentId = createIncident(database);
    database.run(
      "UPDATE trueforge_session_bindings SET coordinator_spec_version = 'm2.6b-v1' WHERE incident_id = ?",
      [incidentId],
    );
    const service = createReceiverObservationService(database, () => now);

    expect(() => service.append(appendInput(incidentId))).toThrow(
      "does not use the current supported Coordinator spec",
    );
    expect(service.listByIncidentId(incidentId)).toEqual([]);
  });

  it("rejects normalized count/state disagreement before persistence", () => {
    const incidentId = createIncident(database);
    const service = createReceiverObservationService(database, () => now);

    expect(() =>
      service.append({
        ...appendInput(incidentId),
        result: {
          schemaVersion: 1,
          deliveryGuid,
          mutationCount: 2,
          businessState: "EXACTLY_ONE",
          observedAt: now,
        },
      }),
    ).toThrow();
    expect(service.listByIncidentId(incidentId)).toEqual([]);
  });
});
