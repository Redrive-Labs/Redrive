import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { createIncidentService } from "@/server/incidents/incident-service";
import { createIncidentInvestigationService } from "@/server/incidents/incident-investigation-service";
import { buildReceiverInvestigatorTask } from "@/server/receiver/receiver-investigation-service";
import { TrueForgeTurnCreateError } from "@/server/trueforge/trueforge-client";

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

function providerEventsForTurn(turnId: string, malformed = false): unknown[] {
  const events = providerEvents();
  for (const event of events) {
    if (event !== null && typeof event === "object" && (event as { type?: unknown }).type === "turn.created") {
      (event as { turnId: string }).turnId = turnId;
    }
  }
  if (malformed) {
    const message = events.find((event) =>
      event !== null && typeof event === "object" &&
      (event as { type?: unknown; threadId?: unknown }).type === "model.message" &&
      (event as { threadId?: unknown }).threadId === "provider-thread-1",
    ) as { toolCalls?: Array<{ function?: { arguments?: string } }> } | undefined;
    const argumentsText = message?.toolCalls?.[0]?.function?.arguments;
    if (argumentsText === undefined || message?.toolCalls?.[0]?.function === undefined) {
      throw new Error("Provider test fixture is missing its investigator tool call.");
    }
    message.toolCalls[0].function.arguments = JSON.stringify({
      ...JSON.parse(argumentsText) as Record<string, unknown>,
      unexpected: true,
    });
  }
  return events;
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

    await expect(
      createIncidentInvestigationService(database, client, environment, () => observedAt)
        .investigateProviderAndReceiverForIncident(incident.id),
    )
      .resolves.toMatchObject({
        turnId: "provider-turn-1",
        providerInvestigatorThreadId: "provider-thread-1",
        receiverObservation: {
          turnId: "receiver-turn-1",
          receiverInvestigatorThreadId: "receiver-thread-1",
        },
        contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
    });
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);

    // Legacy incidents may contain more than one receiver observation. The
    // latest persisted observation is authoritative when v15 provenance is
    // backfilled, including its exact TrueForge turn identity.
    const latestObservationAt = "2026-08-30T00:00:04.000Z";
    database.run(
      `INSERT INTO receiver_observations (
        id, incident_id, application_connection_id, delivery_guid, capability,
        tool, mcp_server_name, mutation_count, business_state, observed_at,
        trueforge_session_id, turn_id, receiver_investigator_thread_id,
        thread_created_event_id, tool_call_id, tool_call_event_id,
        tool_response_event_id, tool_response_created_at, observation_json,
        created_at
      ) SELECT 'receiver-observation-2', incident_id, application_connection_id,
        delivery_guid, capability, tool, mcp_server_name, mutation_count,
        business_state, observed_at, trueforge_session_id, 'receiver-turn-2',
        'receiver-thread-2', 'receiver-thread-created-2', 'receiver-call-2',
        'receiver-response-2', 'receiver-response-event-2', ?, observation_json, ?
      FROM receiver_observations WHERE incident_id = ?`,
      [latestObservationAt, latestObservationAt, incident.id],
    );

    // Migration compatibility: pre-v15 persisted evidence has no reservation
    // row, but still carries exact workflow and receiver provenance.
    database.run("DELETE FROM incident_investigations WHERE incident_id = ?", [incident.id]);
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({
      turnId: "provider-turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      receiverObservation: { turnId: "receiver-turn-2" },
    });
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);
    expect(database.get<{ state: string; providerTurnId: string; receiverTurnId: string }>(
      "SELECT state, provider_turn_id AS providerTurnId, receiver_turn_id AS receiverTurnId FROM incident_investigations WHERE incident_id = ?",
      [incident.id],
    )).toEqual({ state: "COMPLETED", providerTurnId: "provider-turn-1", receiverTurnId: "receiver-turn-2" });
  });

  it("does not create a second Provider chain while a concurrent reservation is still creating", async () => {
    const incident = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: providerDeliveryId,
      repositoryId: "octocat/receiver",
    }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`,
      [incident.id, sessionId, observedAt, observedAt],
    );

    let releaseProvider!: () => void;
    const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn()
        .mockImplementationOnce(async () => {
          await providerGate;
          return lifecycle("provider-turn-1");
        })
        .mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) =>
        iterable(turnId === "provider-turn-1" ? providerEvents() : receiverEvents())),
    };
    const first = createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id);
    await vi.waitFor(() => expect(client.createTurnStream).toHaveBeenCalledTimes(1));

    await expect(
      createIncidentInvestigationService(database, client, environment, () => observedAt)
        .investigateProviderAndReceiverForIncident(incident.id),
    ).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(1);
    expect(database.get<{ state: string }>("SELECT state FROM incident_investigations WHERE incident_id = ?", [incident.id]))
      .toEqual({ state: "PROVIDER_CREATING" });

    releaseProvider();
    await expect(first).resolves.toMatchObject({ contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);
  });

  it("preserves the Provider corrective turn inside one fenced operation", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(`INSERT INTO trueforge_session_bindings (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at) VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`, [incident.id, sessionId, observedAt, observedAt]);

    let turnNumber = 0;
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn().mockImplementation(async () => {
        turnNumber += 1;
        return lifecycle(turnNumber === 1 ? "provider-turn-1" : turnNumber === 2 ? "provider-turn-2" : "receiver-turn-1");
      }),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) => {
        if (turnId === "provider-turn-1") return iterable(providerEventsForTurn(turnId, true));
        if (turnId === "provider-turn-2") return iterable(providerEventsForTurn(turnId));
        return iterable(receiverEvents());
      }),
    };

    const service = createIncidentInvestigationService(database, client, environment, () => observedAt);
    await expect(service.investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
      turnId: "provider-turn-2",
      receiverObservation: { turnId: "receiver-turn-1" },
    });
    expect(client.createTurnStream).toHaveBeenCalledTimes(3);

    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({
      turnId: "provider-turn-2",
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
    });
    expect(client.createTurnStream).toHaveBeenCalledTimes(3);
  });

  it("keeps a known turn running after its stream is interrupted and does not recreate it on retry", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(`INSERT INTO trueforge_session_bindings (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at) VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`, [incident.id, sessionId, observedAt, observedAt]);
    const interrupted = {
      async *[Symbol.asyncIterator]() {
        yield { type: "turn.created", id: "provider-created", turnId: "provider-turn-1", state: { status: "running" } } as TrueForgeApi.TurnStreamingEvent;
        throw new Error("stream interrupted");
      },
    };
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn().mockResolvedValue(interrupted),
      listTurnEvents: vi.fn().mockResolvedValue(iterable([{
        type: "turn.created", id: "provider-created", turnId: "provider-turn-1", state: { status: "running" },
      }])),
    };

    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(1);
    expect(database.get<{ state: string; providerTurnId: string }>("SELECT state, provider_turn_id AS providerTurnId FROM incident_investigations WHERE incident_id = ?", [incident.id]))
      .toEqual({ state: "PROVIDER_RUNNING", providerTurnId: "provider-turn-1" });
  });

  it("does not let a stale preparation owner create a turn after another caller takes the reservation", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(`INSERT INTO trueforge_session_bindings (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at) VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`, [incident.id, sessionId, observedAt, observedAt]);

    let releasePreparation!: () => void;
    const preparation = new Promise<void>((resolve) => { releasePreparation = resolve; });
    let clock = observedAt;
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn(async () => {
        await preparation;
        return { id: sessionId };
      }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn().mockResolvedValue(lifecycle("provider-turn-1")),
      listTurns: vi.fn().mockResolvedValue([]),
      listTurnEvents: vi.fn().mockResolvedValue(iterable([])),
    };

    const first = createIncidentInvestigationService(database, client, environment, () => clock)
      .investigateProviderAndReceiverForIncident(incident.id);
    await vi.waitFor(() => expect(client.getSession).toHaveBeenCalledTimes(1));

    clock = new Date(Date.parse(observedAt) + 61_000).toISOString();
    await expect(createIncidentInvestigationService(database, client, environment, () => clock)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationRetryableError" });

    releasePreparation();
    await expect(first).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    expect(client.createTurnStream).not.toHaveBeenCalled();
  });

  it("treats a terminal cancelled turn as retryable before a serialized new attempt", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(`INSERT INTO trueforge_session_bindings (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at) VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`, [incident.id, sessionId, observedAt, observedAt]);
    database.run(`INSERT INTO incident_investigations (incident_id, state, provider_operation_token, provider_turn_id, receiver_operation_token, receiver_turn_id, failure_stage, failure_code, created_at, updated_at, completed_at) VALUES (?, 'PROVIDER_RUNNING', 'provider-old-token', 'provider-terminal', NULL, NULL, NULL, NULL, ?, ?, NULL)`, [incident.id, observedAt, observedAt]);
    let terminal = true;
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn().mockResolvedValueOnce(lifecycle("provider-turn-1")).mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) => {
        if (turnId === "provider-terminal" && terminal) return iterable([
          { type: "turn.created", id: "terminal-created", turnId, state: { status: "running" } },
          { type: "turn.done", id: "terminal-done", state: { status: "cancelled" } },
        ]);
        return iterable(turnId === "provider-turn-1" ? providerEvents() : receiverEvents());
      }),
    };
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationRetryableError" });
    expect(client.createTurnStream).not.toHaveBeenCalled();
    terminal = false;
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({ contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);
  });

  it("resumes at Receiver after a terminal receiver-start failure without rerunning Provider", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`,
      [incident.id, sessionId, observedAt, observedAt],
    );
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn()
        .mockResolvedValueOnce(lifecycle("provider-turn-1"))
        .mockRejectedValueOnce(new TrueForgeTurnCreateError(sessionId, "receiver rejected", { statusCode: 400, kind: "DEFINITIVE" }))
        .mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) => iterable(turnId === "provider-turn-1" ? providerEvents() : receiverEvents())),
    };

    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toThrow("receiver investigation events could not be collected");
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);

    // A provider-only pre-v15 incident resumes at Receiver from accepted
    // workflow provenance instead of creating another Provider turn.
    database.run("DELETE FROM incident_investigations WHERE incident_id = ?", [incident.id]);

    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({ contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(3);
  });

  it("reconciles an ambiguous Provider POST by its durable marker instead of creating another turn", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`,
      [incident.id, sessionId, observedAt, observedAt],
    );
    let ambiguousInput: TrueForgeApi.TurnInputItem[] | undefined;
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn()
        .mockImplementationOnce(async (_session: string, request: { input: TrueForgeApi.TurnInputItem[] }) => {
          ambiguousInput = request.input;
          throw new Error("response lost after remote create");
        })
        .mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurns: vi.fn(async () => [{ id: "provider-turn-1", input: ambiguousInput, state: { status: "done" } }]),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) => iterable(turnId === "provider-turn-1" ? providerEvents() : receiverEvents())),
    };

    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({ contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED" });
    // The retry adopts the original Provider turn and creates only Receiver.
    expect(client.createTurnStream).toHaveBeenCalledTimes(2);
  });

  it("makes a conclusively absent ambiguous turn retryable without retaining a failed reservation forever", async () => {
    const incident = createIncidentService(database).create({ provider: "github", externalDeliveryId: providerDeliveryId, repositoryId: "octocat/receiver" }).incident;
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", [applicationConnectionId, incident.id]);
    database.run(
      `INSERT INTO trueforge_session_bindings
        (incident_id, state, trueforge_session_id, creation_token, coordinator_spec_version, created_at, updated_at)
       VALUES (?, 'ACTIVE', ?, NULL, 'm2.6b-v1', ?, ?)`,
      [incident.id, sessionId, observedAt, observedAt],
    );
    const client = {
      createSession: vi.fn().mockResolvedValue("replacement-session"),
      getSession: vi.fn().mockResolvedValue({ id: sessionId }),
      updateSession: vi.fn().mockResolvedValue(undefined),
      createTurnStream: vi.fn()
        .mockRejectedValueOnce(new Error("response lost"))
        .mockResolvedValueOnce(lifecycle("provider-turn-1"))
        .mockResolvedValueOnce(lifecycle("receiver-turn-1")),
      listTurns: vi.fn(async () => []),
      listTurnEvents: vi.fn().mockImplementation(async (_session: string, turnId: string) => iterable(turnId === "provider-turn-1" ? providerEvents() : receiverEvents())),
    };
    const firstService = createIncidentInvestigationService(database, client, environment, () => observedAt);
    await expect(firstService.investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationInProgressError" });
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).rejects.toMatchObject({ name: "IncidentInvestigationRetryableError" });
    await expect(createIncidentInvestigationService(database, client, environment, () => observedAt)
      .investigateProviderAndReceiverForIncident(incident.id)).resolves.toMatchObject({ contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED" });
    expect(client.createTurnStream).toHaveBeenCalledTimes(3);
  });
});
