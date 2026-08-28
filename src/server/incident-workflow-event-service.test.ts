import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import { createIncidentWorkflowEventService } from "@/server/incident-workflow-event-service";

describe("incident workflow provenance", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-workflow-events-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  function createIncident(): string {
    return createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: "delivery-1",
      repositoryId: "example/receiver",
    }).incident.id;
  }

  it("persists attributable scalar events and deduplicates TrueForge event IDs", () => {
    const incidentId = createIncident();
    const events = createIncidentWorkflowEventService(
      database,
      () => "2026-01-01T00:00:00.000Z",
    );

    const first = events.append({
      incidentId,
      eventType: "PROVIDER_INVESTIGATOR_STARTED",
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      trueForgeEventId: "tf-event-1",
      toolCallId: "spawn-call",
      occurredAt: "2026-01-01T00:00:01.000Z",
      details: { agentName: "provider-investigator", parentThreadId: "main" },
    });
    const duplicate = events.append({
      incidentId,
      eventType: "PROVIDER_INVESTIGATOR_STARTED",
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      trueForgeEventId: "tf-event-1",
      toolCallId: "spawn-call",
      occurredAt: "2026-01-01T00:00:01.000Z",
      details: { parentThreadId: "main", agentName: "provider-investigator" },
    });

    expect(duplicate).toEqual(first);
    expect(events.listByIncidentId(incidentId)).toHaveLength(1);
    expect(events.listByIncidentId(incidentId)[0].details).toEqual({
      agentName: "provider-investigator",
      parentThreadId: "main",
    });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM incident_workflow_events",
      ),
    ).toEqual({ count: 1 });
  });

  it("rejects a duplicate TrueForge event with a changed event type", () => {
    const incidentId = createIncident();
    const events = createIncidentWorkflowEventService(database);
    const original = {
      incidentId,
      eventType: "PROVIDER_INVESTIGATOR_STARTED" as const,
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      trueForgeEventId: "tf-event-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      details: { observation: "same" },
    };
    events.append(original);

    expect(() =>
      events.append({
        ...original,
        eventType: "PROVIDER_EVIDENCE_CAPTURED",
      }),
    ).toThrow("does not match the existing durable event");
    expect(events.listByIncidentId(incidentId)).toHaveLength(1);
  });

  it.each([
    ["session", { trueForgeSessionId: "session-2" }],
    ["turn", { turnId: "turn-2" }],
    ["provider thread", { providerInvestigatorThreadId: "thread-2" }],
    ["tool call", { toolCallId: "tool-call-2" }],
  ])("rejects a duplicate TrueForge event with changed %s attribution", (_name, change) => {
    const incidentId = createIncident();
    const events = createIncidentWorkflowEventService(database);
    const original = {
      incidentId,
      eventType: "PROVIDER_INVESTIGATOR_STARTED" as const,
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      trueForgeEventId: "tf-event-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      details: { observation: "same" },
    };
    events.append(original);

    expect(() => events.append({ ...original, ...change })).toThrow(
      "does not match the existing durable event",
    );
    expect(events.listByIncidentId(incidentId)).toHaveLength(1);
  });

  it("rejects a duplicate TrueForge event with changed timestamp or details", () => {
    const incidentId = createIncident();
    const events = createIncidentWorkflowEventService(database);
    const original = {
      incidentId,
      eventType: "PROVIDER_INVESTIGATOR_STARTED" as const,
      trueForgeSessionId: "session-1",
      turnId: "turn-1",
      providerInvestigatorThreadId: "thread-1",
      trueForgeEventId: "tf-event-1",
      toolCallId: "tool-call-1",
      occurredAt: "2026-01-01T00:00:01.000Z",
      details: { observation: "same" },
    };
    events.append(original);

    expect(() =>
      events.append({
        ...original,
        occurredAt: "2026-01-01T00:00:02.000Z",
      }),
    ).toThrow("does not match the existing durable event");
    expect(() =>
      events.append({
        ...original,
        details: { observation: "changed" },
      }),
    ).toThrow("does not match the existing durable event");
    expect(events.listByIncidentId(incidentId)).toHaveLength(1);
  });

  it("does not reuse a TrueForge event ID across incidents", () => {
    const firstIncidentId = createIncident();
    const secondIncidentId = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: "delivery-2",
      repositoryId: "example/receiver",
    }).incident.id;
    const events = createIncidentWorkflowEventService(database);

    events.append({
      incidentId: firstIncidentId,
      eventType: "PROVIDER_INVESTIGATION_STARTED",
      trueForgeEventId: "shared-event-id",
    });

    expect(() =>
      events.append({
        incidentId: secondIncidentId,
        eventType: "PROVIDER_INVESTIGATION_STARTED",
        trueForgeEventId: "shared-event-id",
      }),
    ).toThrow("different incident");
  });

  it("does not accept nested transcript or payload details", () => {
    const incidentId = createIncident();
    const events = createIncidentWorkflowEventService(database);

    expect(() =>
      events.append({
        incidentId,
        eventType: "PROVIDER_INVESTIGATION_STARTED",
        details: { transcript: { reasoning: "not persisted" } } as never,
      }),
    ).toThrow("scalar");
  });
});
