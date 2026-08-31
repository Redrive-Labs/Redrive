import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { createIncidentService } from "@/server/incidents/incident-service";
import { createIncidentInvestigationService } from "@/server/incidents/incident-investigation-service";
import { buildReceiverInvestigatorTask } from "@/server/receiver/receiver-investigation-service";

const applicationConnectionId = "application-connection-1";
const providerDeliveryId = "provider-delivery-1";
const providerDeliveryGuid = "provider-delivery-guid-1";
const sessionId = "existing-session";
const observedAt = "2026-08-30T00:00:02.000Z";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  REDRIVE_TRUEFORGE_MODEL: "configured-model",
  REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "redrive-github",
  REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "github-token",
  REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: "redrive-receiver",
  REDRIVE_RECEIVER_MCP_TOKEN: "receiver-token",
};

function iterable<T>(items: unknown[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item as T;
    },
  };
}

function lifecycle(turnId: string): AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
  return iterable([
    {
      type: "turn.created",
      id: `${turnId}-created`,
      turnId,
      state: { status: "running" },
    },
    {
      type: "turn.done",
      id: `${turnId}-done`,
      state: { status: "done" },
    },
  ]);
}

function providerEvents(): unknown[] {
  return [
    {
      type: "turn.created",
      id: "provider-turn-created",
      turnId: "provider-turn-1",
      state: { status: "running" },
    },
    {
      type: "model.message",
      id: "provider-spawn-model",
      threadId: "main",
      toolCalls: [
        {
          id: "provider-spawn-call",
          type: "function",
          function: {
            name: "create_sub_agent",
            arguments: JSON.stringify({
              name: "provider-investigator",
              input: "provider-only investigation",
            }),
          },
          toolInfo: {
            type: "truefoundry-system",
            name: "create_sub_agent",
          },
        },
      ],
    },
    {
      type: "thread.created",
      id: "provider-thread-created",
      threadId: "provider-thread-1",
      createdAt: "2026-08-30T00:00:01.000Z",
      parent: { threadId: "main", toolCallId: "provider-spawn-call" },
      agentInfo: {
        type: "dynamic",
        name: "provider-investigator",
        input: "provider-only investigation",
      },
    },
    {
      type: "model.message",
      id: "provider-model",
      threadId: "provider-thread-1",
      toolCalls: [
        {
          id: "provider-call",
          type: "function",
          function: {
            name: "get_webhook_delivery",
            arguments: JSON.stringify({
              connection_id: applicationConnectionId,
              delivery_id: providerDeliveryId,
            }),
          },
          toolInfo: {
            type: "mcp",
            name: "get_webhook_delivery",
            serverName: "redrive-github",
          },
        },
      ],
    },
    {
      type: "tool.response",
      id: "provider-response",
      createdAt: observedAt,
      threadId: "provider-thread-1",
      toolCallId: "provider-call",
      content: JSON.stringify({
        full: {
          http_status: 200,
          body: {
            id: providerDeliveryId,
            guid: providerDeliveryGuid,
            event: "push",
            status: "Invalid HTTP Response: 500",
            status_code: 500,
            delivered_at: "2026-08-30T00:00:00.000Z",
            redelivery: false,
            repository_id: 1,
            request: {
              headers: {
                "X-GitHub-Delivery": providerDeliveryGuid,
                "X-GitHub-Event": "push",
              },
              payload: {
                repository: { id: 1, full_name: "octocat/receiver" },
              },
            },
            response: {
              headers: { "content-type": "text/plain" },
              payload: "receiver failed",
            },
          },
        },
      }),
    },
    {
      type: "tool.response",
      id: "provider-spawn-response",
      createdAt: observedAt,
      threadId: "main",
      toolCallId: "provider-spawn-call",
      content: "",
    },
    {
      type: "turn.done",
      id: "provider-turn-done",
      state: { status: "done" },
    },
  ];
}

function receiverEvents(): unknown[] {
  const task = buildReceiverInvestigatorTask(
    applicationConnectionId,
    providerDeliveryGuid,
  );
  return [
    {
      type: "turn.created",
      id: "receiver-turn-created",
      turnId: "receiver-turn-1",
      state: { status: "running" },
    },
    {
      type: "model.message",
      id: "receiver-spawn-model",
      threadId: "main",
      toolCalls: [
        {
          id: "receiver-spawn-call",
          type: "function",
          function: {
            name: "create_sub_agent",
            arguments: JSON.stringify({
              name: "receiver-investigator",
              input: task,
            }),
          },
          toolInfo: {
            type: "truefoundry-system",
            name: "create_sub_agent",
          },
        },
      ],
    },
    {
      type: "thread.created",
      id: "receiver-thread-created",
      threadId: "receiver-thread-1",
      createdAt: "2026-08-30T00:00:03.000Z",
      parent: { threadId: "main", toolCallId: "receiver-spawn-call" },
      agentInfo: {
        type: "dynamic",
        name: "receiver-investigator",
        input: task,
      },
    },
    {
      type: "model.message",
      id: "receiver-model",
      threadId: "receiver-thread-1",
      toolCalls: [
        {
          id: "receiver-call",
          type: "function",
          function: {
            name: "get_business_state",
            arguments: JSON.stringify({
              connection_id: applicationConnectionId,
              delivery_guid: providerDeliveryGuid,
            }),
          },
          toolInfo: {
            type: "mcp",
            name: "get_business_state",
            serverName: "redrive-receiver",
          },
        },
      ],
    },
    {
      type: "tool.response",
      id: "receiver-response",
      createdAt: observedAt,
      threadId: "receiver-thread-1",
      toolCallId: "receiver-call",
      content: JSON.stringify({
        schemaVersion: 1,
        deliveryGuid: providerDeliveryGuid,
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
        observedAt,
      }),
    },
    {
      type: "tool.response",
      id: "receiver-spawn-response",
      createdAt: observedAt,
      threadId: "main",
      toolCallId: "receiver-spawn-call",
      content: "",
    },
    {
      type: "turn.done",
      id: "receiver-turn-done",
      state: { status: "done" },
    },
  ];
}

describe("incident provider and receiver investigation orchestration", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-incident-investigation-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["app-1", "app-id", "redrive", "owner-id", "octocat", "User", "key", observedAt, observedAt],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["installation-1", "app-1", "owner-id", "octocat", "User", "selected", observedAt, observedAt, observedAt],
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
        observedAt,
        observedAt,
      ],
    );
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  it("runs provider then receiver in one persistent session and derives the contradiction", async () => {
    const incident = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: providerDeliveryId,
      repositoryId: "octocat/receiver",
    }).incident;
    database.run(
      "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
      [applicationConnectionId, incident.id],
    );
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token,
         coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`,
      [incident.id, sessionId, observedAt, observedAt],
    );

    const providerTurnEvents = providerEvents();
    const receiverTurnEvents = receiverEvents();
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi
        .fn()
        .mockResolvedValueOnce(lifecycle("provider-turn-1"))
        .mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurnEvents: vi.fn().mockImplementation(
        async (_session: string, turnId: string) =>
          iterable(
            turnId === "provider-turn-1"
              ? providerTurnEvents
              : receiverTurnEvents,
          ),
      ),
    };
    const service = createIncidentInvestigationService(
      database,
      client,
      environment,
      () => observedAt,
    );

    const result = await service.investigateProviderAndReceiverForIncident(
      incident.id,
    );

    expect(result).toMatchObject({
      incidentId: incident.id,
      trueForgeSessionId: sessionId,
      providerStatusCode: 500,
      receiverObservation: {
        turnId: "receiver-turn-1",
        receiverInvestigatorThreadId: "receiver-thread-1",
        deliveryGuid: providerDeliveryGuid,
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
      },
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
      recoveryState: "BLOCKED",
    });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).toHaveBeenNthCalledWith(
      1,
      sessionId,
      expect.objectContaining({ input: expect.any(Array) }),
    );
    expect(client.createTurnStream).toHaveBeenNthCalledWith(
      2,
      sessionId,
      expect.objectContaining({ input: expect.any(Array) }),
    );
    expect(client.listTurnEvents).toHaveBeenNthCalledWith(
      1,
      sessionId,
      "provider-turn-1",
    );
    expect(client.listTurnEvents).toHaveBeenNthCalledWith(
      2,
      sessionId,
      "receiver-turn-1",
    );
    expect(
      database.get<{ coordinator_spec_version: string }>(
        "SELECT coordinator_spec_version FROM trueforge_session_bindings WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ coordinator_spec_version: "m2.7-v1" });
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ count: 1 });
  });
});
