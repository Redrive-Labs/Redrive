import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_RECOVERY_COORDINATOR_SPEC_VERSION,
  RECOVERY_COORDINATOR_SPEC_VERSION,
} from "@/agents/recovery-coordinator";
import {
  createProviderEvidenceService,
  ProviderEvidenceConflictError,
} from "@/server/provider-evidence-service";
import { createIncidentService } from "@/server/incident-service";
import { createIncidentWorkflowEventService } from "@/server/incident-workflow-event-service";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import {
  createProviderInvestigationService,
  extractGithubDeliveryFromTrueForgeToolResponse,
  ConnectionBackedProviderInvestigationUnsupportedError,
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
  PROVIDER_INVESTIGATOR_NAME,
} from "@/server/provider-investigation-service";
import {
  TrueForgeSessionSpecUpgradeError,
  TrueForgeSessionUnavailableError,
} from "@/server/trueforge-session-service";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { GithubMcpConfigurationError } from "@/server/github-mcp";

const deliveryId = "900719925474099312345678901234567890";
const repositoryId = "example/receiver";
const hookId = "hook-42";
const mcpServerName = "redrive-github";
const environment = {
  NODE_ENV: "test",
  REDRIVE_TRUEFORGE_MODEL: "configured-model",
  REDRIVE_TRUEFORGE_GITHUB_MCP_NAME: mcpServerName,
  REDRIVE_GITHUB_HOOK_IDS: JSON.stringify({ [repositoryId]: hookId }),
} as const;

function makeGithubResult(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    id: deliveryId,
    guid: "logical-guid-1",
    event: "push",
    status: "Invalid HTTP Response: 500",
    status_code: 500,
    delivered_at: "2026-08-25T09:56:40.78Z",
    redelivery: false,
    repository_id: 1345932290,
    request: {
      headers: {
        "X-GitHub-Delivery": "logical-guid-1",
        "X-GitHub-Event": "push",
      },
      payload: {
        ref: "refs/heads/main",
        repository: {
          id: 1345932290,
          full_name: repositoryId,
        },
      },
    },
    response: {
      headers: { "content-type": "text/plain" },
      payload: "receiver failed",
    },
    ...overrides,
  };

  return {
    full: {
      http_status: 200,
      body,
    },
  };
}

interface StreamOptions {
  agentName?: string;
  modelThreadId?: string;
  toolName?: string;
  toolInfoName?: string;
  toolInfoServerName?: string;
  hookArgument?: string;
  deliveryArgument?: string;
  expectedDeliveryId?: string;
  includeResponse?: boolean;
  includeRootToolCall?: boolean;
  includeEmptySpawnResponse?: boolean;
  responseThreadId?: string;
  responseToolCallId?: string;
  responseContent?: string;
}

function makeStream(
  options: StreamOptions = {},
): AsyncIterable<TrueForgeApi.TurnStreamingEvent> & { events: unknown[] } {
  const providerThreadId = "provider-thread-1";
  const toolCallId = "github-call-1";
  const events: unknown[] = [
    {
      type: "turn.created",
      id: "turn-created-event",
      turnId: "turn-1",
      previousTurnId: null,
      state: { status: "running" },
      createdAt: "2026-08-25T10:00:00.000Z",
      threadId: null,
    },
    {
      type: "model.message",
      id: "spawn-provider-model-event",
      threadId: "main",
      content: null,
      toolCalls: [
        {
          id: "spawn-provider-1",
          type: "function",
          function: {
            name: "create_sub_agent",
            arguments: JSON.stringify({
              name: options.agentName ?? PROVIDER_INVESTIGATOR_NAME,
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
      id: "thread-created-event",
      threadId: providerThreadId,
      title: "Provider investigator",
      createdAt: "2026-08-25T10:00:01.000Z",
      parent: { threadId: "main", toolCallId: "spawn-provider-1" },
      agentInfo: {
        type: "dynamic",
        name: options.agentName ?? PROVIDER_INVESTIGATOR_NAME,
        input: "provider-only investigation",
      },
    },
    {
      type: "model.message",
      id: "provider-model-event",
      threadId: options.modelThreadId ?? providerThreadId,
      content: null,
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: options.toolName ?? "get_webhook_delivery",
            arguments: JSON.stringify({
              hook_id: options.hookArgument ?? hookId,
              delivery_id:
                options.deliveryArgument ?? options.expectedDeliveryId ?? deliveryId,
            }),
          },
          toolInfo: {
            type: "mcp",
            name: options.toolInfoName ?? "get_webhook_delivery",
            serverId: "mcp-server-1",
            serverName: options.toolInfoServerName ?? mcpServerName,
          },
        },
      ],
    },
  ];

  if (options.includeRootToolCall) {
    events.push({
      type: "model.message",
      id: "root-model-event",
      threadId: "main",
      content: null,
      toolCalls: [
        {
          id: "root-github-call",
          type: "function",
          function: {
            name: "get_webhook_delivery",
            arguments: JSON.stringify({
              hook_id: options.hookArgument ?? hookId,
              delivery_id:
                options.deliveryArgument ?? options.expectedDeliveryId ?? deliveryId,
            }),
          },
          toolInfo: {
            type: "mcp",
            name: "get_webhook_delivery",
            serverId: "mcp-server-1",
            serverName: options.toolInfoServerName ?? mcpServerName,
          },
        },
      ],
    });
  }

  if (options.includeResponse !== false) {
    events.push({
      type: "tool.response",
      id: "tool-response-event",
      createdAt: "2026-08-25T10:00:02.000Z",
      threadId: options.responseThreadId ?? providerThreadId,
      toolCallId: options.responseToolCallId ?? toolCallId,
      content:
        options.responseContent ?? JSON.stringify(makeGithubResult()),
    });
  }
  if (options.includeEmptySpawnResponse) {
    // Matches the live TrueForge sequence:
    // child finishes after its authoritative MCP response, then the root
    // create_sub_agent system-tool completion emits content="".
    events.push(
      {
        type: "model.message",
        id: "provider-finished-event",
        threadId: providerThreadId,
        content: "Provider investigation complete.",
        toolCalls: [],
      },
      {
        type: "tool.response",
        id: "spawn-provider-response-event",
        createdAt: "2026-08-25T10:00:02.500Z",
        threadId: "main",
        toolCallId: "spawn-provider-1",
        content: "",
      },
    );
  }
  events.push({
    type: "turn.done",
    id: "turn-done-event",
    createdAt: "2026-08-25T10:00:03.000Z",
    threadId: null,
    state: { status: "done" },
  });

  if (options.expectedDeliveryId !== undefined) {
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        "id" in event &&
        typeof event.id === "string"
      ) {
        event.id = `${event.id}-${options.expectedDeliveryId}`;
      }
    }
  }

  return {
    events,
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event as TrueForgeApi.TurnStreamingEvent;
      }
    },
  };
}

function persistedTurnEvents(events: unknown[]): AsyncIterable<TrueForgeApi.SessionEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event as TrueForgeApi.SessionEvent;
      }
    },
  };
}

function createClient(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent> & { events?: unknown[] },
) {
  return {
    createSession: vi.fn().mockResolvedValue("replacement-session"),
    getSession: vi.fn().mockResolvedValue({ id: "existing-session" }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    createTurnStream: vi.fn().mockResolvedValue(stream),
    listTurnEvents: vi.fn().mockResolvedValue(
      persistedTurnEvents(stream.events ?? []),
    ),
  };
}

describe("TrueForge provider investigation", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-provider-investigation-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  function createIncident(externalDeliveryId = deliveryId) {
    return createIncidentService(database).create({
      provider: "github",
      externalDeliveryId,
      repositoryId,
    }).incident;
  }

  function installActiveBinding(
    incidentId: string,
    sessionId = "existing-session",
    coordinatorSpecVersion: string = LEGACY_RECOVERY_COORDINATOR_SPEC_VERSION,
  ): void {
    database.run(
      `
        INSERT INTO trueforge_session_bindings (
          incident_id,
          state,
          trueforge_session_id,
          creation_token,
          coordinator_spec_version,
          created_at,
          updated_at
        ) VALUES (?, 'ACTIVE', ?, NULL, ?, ?, ?)
      `,
      [
        incidentId,
        sessionId,
        coordinatorSpecVersion,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
  }

  function failWorkflowEventPersistenceOnce(eventType: string): () => boolean {
    const originalRun = database.run.bind(database);
    let injectedFailure = false;
    vi.spyOn(database, "run").mockImplementation((sql, parameters) => {
      if (
        !injectedFailure &&
        sql.includes("INSERT INTO incident_workflow_events") &&
        parameters !== null &&
        parameters !== undefined &&
        !Array.isArray(parameters) &&
        typeof parameters === "object" &&
        (parameters as Record<string, unknown>).eventType === eventType
      ) {
        injectedFailure = true;
        throw new Error("injected workflow event persistence failure");
      }
      return originalRun(sql, parameters);
    });
    return () => injectedFailure;
  }

  it("fails closed for a connection-backed incident before legacy hook or TrueForge lookup", async () => {
    const incident = createIncident("connection-delivery");
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["app-connection", "app-id", "redrive", "owner-id", "octocat", "User", "key", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["installation-connection", "app-connection", "owner-id", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO application_connections
        (id, provider, github_installation_id, repository_id,
         repository_full_name, webhook_id, webhook_target_display, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["connection-incident", "github", "installation-connection", repositoryId, repositoryId, "hook-A", "https://receiver.example/webhook", "READY", "2026-01-01", "2026-01-01"],
    );
    database.run(
      "UPDATE incidents SET application_connection_id = ? WHERE id = ?",
      ["connection-incident", incident.id],
    );

    const environmentWithLegacyHook = {
      ...environment,
      REDRIVE_GITHUB_HOOK_IDS: JSON.stringify({ [repositoryId]: "hook-B" }),
    };
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(
      database,
      client,
      environmentWithLegacyHook,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      ConnectionBackedProviderInvestigationUnsupportedError,
    );
    expect(client.getSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(client.listTurnEvents).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_evidence",
      )?.count,
    ).toBe(0);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM incident_workflow_events",
      )?.count,
    ).toBe(0);
  });

  it("collects only the exact completed turn, not unrelated session history", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const persisted = makeStream();
    const unrelatedSessionHistory = [
      {
        type: "model.message",
        id: "unrelated-model-event",
        threadId: "unrelated-thread",
        content: "unrelated session history",
      },
    ];
    const liveEvents = persisted.events.filter((event) =>
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      (event.type === "turn.created" || event.type === "turn.done"),
    );
    const liveStream = {
      events: liveEvents,
      async *[Symbol.asyncIterator]() {
        for (const event of liveEvents) {
          yield event as TrueForgeApi.TurnStreamingEvent;
        }
      },
    };
    const client = createClient(liveStream);
    client.listTurnEvents.mockImplementation((_sessionId, turnId) =>
      Promise.resolve(
        persistedTurnEvents(
          turnId === "turn-1" ? persisted.events : unrelatedSessionHistory,
        ),
      ),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(liveEvents.map((event) => (event as { type: string }).type)).toEqual([
      "turn.created",
      "turn.done",
    ]);
    expect(result).toMatchObject({
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      providerStatusCode: 500,
    });
    expect(client.listTurnEvents).toHaveBeenCalledWith(
      "existing-session",
      "turn-1",
    );
  });

  it("reuses and upgrades the existing session, then reobserves immutable evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const evidenceService = createProviderEvidenceService(database, null, () =>
      "2026-08-25T09:00:00.000Z",
    );
    const existing = evidenceService.captureOrReconcileForIncident(
      incident.id,
      makeGithubResult(),
    ).evidence;
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
      () => "2026-08-25T09:59:00.000Z",
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result).toMatchObject({
      incidentId: incident.id,
      trueForgeSessionId: "existing-session",
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      evidenceDisposition: "REOBSERVED",
      providerStatusCode: 500,
    });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.updateSession).toHaveBeenCalledTimes(1);
    expect(client.createTurnStream).toHaveBeenCalledWith(
      "existing-session",
      expect.objectContaining({
        input: [
          expect.objectContaining({
            content: expect.stringContaining(`hook_id=${hookId}`),
          }),
        ],
      }),
    );
    expect(
      database.get<{ coordinator_spec_version: string }>(
        "SELECT coordinator_spec_version FROM trueforge_session_bindings WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ coordinator_spec_version: RECOVERY_COORDINATOR_SPEC_VERSION });
    expect(evidenceService.getByIncidentId(incident.id)).toEqual(existing);

    const events = service.getWorkflowEvents(incident.id);
    expect(events.map((event) => event.eventType)).toEqual([
      "PROVIDER_INVESTIGATION_STARTED",
      "PROVIDER_INVESTIGATOR_STARTED",
      "PROVIDER_EVIDENCE_REOBSERVED",
    ]);
    expect(events[1]).toMatchObject({
      trueForgeSessionId: "existing-session",
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      trueForgeEventId: "thread-created-event",
      toolCallId: "spawn-provider-1",
    });
    expect(events[2]).toMatchObject({
      trueForgeEventId: "tool-response-event",
      toolCallId: "github-call-1",
    });
    expect(JSON.stringify(events)).not.toContain("receiver failed");
  });

  it("reconciles the current v2 AgentSpec before using the existing session for a turn", async () => {
    const incident = createIncident();
    installActiveBinding(
      incident.id,
      "existing-v2-session",
      RECOVERY_COORDINATOR_SPEC_VERSION,
    );
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(database, client, environment);

    await service.investigateProviderForIncident(incident.id);

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.updateSession).toHaveBeenCalledWith(
      "existing-v2-session",
      expect.objectContaining({
        model: { name: environment.REDRIVE_TRUEFORGE_MODEL },
        mcpServers: [
          expect.objectContaining({
            name: environment.REDRIVE_TRUEFORGE_GITHUB_MCP_NAME,
          }),
        ],
      }),
    );
    expect(client.updateSession.mock.invocationCallOrder[0]).toBeLessThan(
      client.createTurnStream.mock.invocationCallOrder[0],
    );
  });

  it("captures first evidence from the correlated tool.response", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
      () => "2026-08-25T10:00:04.000Z",
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result.evidenceDisposition).toBe("CAPTURED");
    const evidence = createProviderEvidenceService(database, null).getByIncidentId(
      incident.id,
    );
    expect(evidence).toMatchObject({
      providerDeliveryId: deliveryId,
      deliveryGuid: "logical-guid-1",
      outcome: { statusCode: 500 },
    });
  });

  it("fails before remote session work when deterministic inputs are unavailable", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id, "existing-session");
    const client = createClient(makeStream());
    const environmentWithoutHook: NodeJS.ProcessEnv = { ...environment };
    delete environmentWithoutHook.REDRIVE_GITHUB_HOOK_IDS;
    const service = createProviderInvestigationService(
      database,
      client,
      environmentWithoutHook,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      GithubMcpConfigurationError,
    );
    expect(client.getSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
  });

  it("does not start a turn for an unusable persisted session", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id, "lost-session");
    database.run(
      "UPDATE trueforge_session_bindings SET state = 'LOST' WHERE incident_id = ?",
      [incident.id],
    );
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(database, client, environment);

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      TrueForgeSessionUnavailableError,
    );
    expect(client.getSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
  });

  it("does not start a turn when current v2 session reconciliation fails", async () => {
    const incident = createIncident();
    installActiveBinding(
      incident.id,
      "v2-session",
      RECOVERY_COORDINATOR_SPEC_VERSION,
    );
    const client = createClient(makeStream());
    client.updateSession.mockRejectedValue(new Error("TrueForge update failed"));
    const service = createProviderInvestigationService(database, client, environment);

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      TrueForgeSessionSpecUpgradeError,
    );
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(
      database.get<{ coordinator_spec_version: string }>(
        "SELECT coordinator_spec_version FROM trueforge_session_bindings WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ coordinator_spec_version: RECOVERY_COORDINATOR_SPEC_VERSION });
  });

  it("rejects root-thread calls, wrong subagents, wrong MCP resources, and wrong IDs", async () => {
    const cases: StreamOptions[] = [
      { modelThreadId: "main" },
      { agentName: "other-investigator" },
      { toolInfoServerName: "other-server" },
      { toolName: "redeliver_webhook_delivery", toolInfoName: "redeliver_webhook_delivery" },
      { hookArgument: "wrong-hook" },
      { deliveryArgument: "wrong-delivery" },
      { includeRootToolCall: true },
    ];

    for (const [index, options] of cases.entries()) {
      const incident = createIncident(`${deliveryId}-${index}`);
      installActiveBinding(incident.id, `existing-session-${index}`);
      const client = createClient(
        makeStream({ ...options, expectedDeliveryId: incident.externalDeliveryId }),
      );
      const service = createProviderInvestigationService(
        database,
        client,
        environment,
      );

      await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
        ProviderInvestigationTurnError,
      );
      expect(
        createProviderEvidenceService(database, null).getByIncidentId(incident.id),
      ).toBeNull();
    }
  });

  it("requires the matching response and never treats prose as evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream({ includeResponse: false }));
    const service = createProviderInvestigationService(database, client, environment);

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      ProviderInvestigationTurnError,
    );
    expect(
      createProviderEvidenceService(database, null).getByIncidentId(incident.id),
    ).toBeNull();
    expect(
      service
        .getWorkflowEvents(incident.id)
        .find((event) => event.eventType === "PROVIDER_INVESTIGATION_FAILED"),
    ).toMatchObject({
      eventType: "PROVIDER_INVESTIGATION_FAILED",
      trueForgeSessionId: "existing-session",
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      toolCallId: "github-call-1",
    });

    const proseIncident = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: "prose-delivery",
      repositoryId,
    }).incident;
    installActiveBinding(proseIncident.id, "prose-session");
    const proseClient = createClient(
      makeStream({ includeResponse: false }),
    );
    // Replace the only model tool call with a prose-only model message.
    const proseEvents = [
      {
        type: "turn.created",
        id: "turn-created-event-prose",
        turnId: "turn-prose",
        state: { status: "running" },
      },
      {
        type: "thread.created",
        id: "thread-created-event-prose",
        threadId: "provider-thread-prose",
        title: "Provider investigator",
        createdAt: "2026-08-25T10:00:01.000Z",
        parent: { threadId: "main", toolCallId: "spawn-prose" },
        agentInfo: {
          type: "dynamic",
          name: PROVIDER_INVESTIGATOR_NAME,
          input: "provider-only investigation",
        },
      },
      {
        type: "model.message",
        id: "prose-model-event",
        threadId: "provider-thread-prose",
        content: "GitHub returned HTTP 500",
      },
      {
        type: "turn.done",
        id: "turn-done-event-prose",
        state: { status: "done" },
      },
    ];
    proseClient.createTurnStream.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        for (const event of proseEvents) yield event as never;
      },
    });
    proseClient.listTurnEvents.mockResolvedValue(
      persistedTurnEvents(proseEvents),
    );
    const proseService = createProviderInvestigationService(
      database,
      proseClient,
      environment,
    );

    await expect(
      proseService.investigateProviderForIncident(proseIncident.id),
    ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);
    expect(
      createProviderEvidenceService(database, null).getByIncidentId(proseIncident.id),
    ).toBeNull();
  });

  it("records conflict and leaves the original immutable snapshot untouched", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const evidenceService = createProviderEvidenceService(database, null, () =>
      "2026-08-25T09:00:00.000Z",
    );
    const original = evidenceService.captureOrReconcileForIncident(
      incident.id,
      makeGithubResult(),
    ).evidence;
    const client = createClient(
      makeStream({
        responseContent: JSON.stringify(
          makeGithubResult({
            status: "Delivered",
            status_code: 200,
            response: { headers: {}, payload: "later result" },
          }),
        ),
      }),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      ProviderEvidenceConflictError,
    );
    expect(evidenceService.getByIncidentId(incident.id)).toEqual(original);
    const workflowEvents = service.getWorkflowEvents(incident.id);
    expect(
      workflowEvents.filter(
        (event) => event.eventType === "PROVIDER_OBSERVATION_CONFLICT",
      ),
    ).toHaveLength(1);
    expect(workflowEvents.map((event) => event.eventType)).toEqual(
      expect.arrayContaining([
        "PROVIDER_OBSERVATION_CONFLICT",
        "PROVIDER_INVESTIGATION_FAILED",
      ]),
    );
    expect(
      workflowEvents.find(
        (event) => event.eventType === "PROVIDER_INVESTIGATION_FAILED",
      )?.details,
    ).toMatchObject({ sourceTrueForgeEventId: "tool-response-event" });
  });

  it("rolls back evidence when a conflicting provenance replay is encountered", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const workflowEvents = createIncidentWorkflowEventService(database);
    const conflictingEvent = workflowEvents.append({
      incidentId: incident.id,
      eventType: "PROVIDER_EVIDENCE_CAPTURED",
      trueForgeSessionId: "different-session",
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      trueForgeEventId: "tool-response-event",
      toolCallId: "github-call-1",
      occurredAt: "2026-08-25T10:00:02.000Z",
      details: { providerDeliveryId: "different-delivery" },
    });
    const service = createProviderInvestigationService(
      database,
      createClient(makeStream()),
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).rejects.toThrow("does not match the existing durable event");

    expect(
      createProviderEvidenceService(database, null).getByIncidentId(incident.id),
    ).toBeNull();
    expect(workflowEvents.getByTrueForgeEventId("tool-response-event")).toEqual(
      conflictingEvent,
    );
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM incident_workflow_events
         WHERE incident_id = ? AND event_type = 'PROVIDER_EVIDENCE_CAPTURED'`,
        [incident.id],
      ),
    ).toEqual({ count: 1 });
  });

  it("rolls back first-capture evidence when its workflow event cannot persist", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream());
    const failureInjected = failWorkflowEventPersistenceOnce(
      "PROVIDER_EVIDENCE_CAPTURED",
    );

    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toThrow(
      "injected workflow event persistence failure",
    );
    expect(
      createProviderEvidenceService(database, null).getByIncidentId(incident.id),
    ).toBeNull();
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM incident_workflow_events
         WHERE incident_id = ? AND event_type = 'PROVIDER_EVIDENCE_CAPTURED'`,
        [incident.id],
      ),
    ).toEqual({ count: 0 });
    expect(failureInjected()).toBe(true);
  });

  it("does not append a reobservation event without committing its transaction", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const evidenceService = createProviderEvidenceService(database, null, () =>
      "2026-08-25T09:00:00.000Z",
    );
    const original = evidenceService.captureOrReconcileForIncident(
      incident.id,
      makeGithubResult(),
    ).evidence;
    const failureInjected = failWorkflowEventPersistenceOnce(
      "PROVIDER_EVIDENCE_REOBSERVED",
    );
    const service = createProviderInvestigationService(
      database,
      createClient(makeStream()),
      environment,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toThrow(
      "injected workflow event persistence failure",
    );

    expect(evidenceService.getByIncidentId(incident.id)).toEqual(original);
    expect(
      database.get<{ count: number }>(
        `SELECT COUNT(*) AS count
         FROM incident_workflow_events
         WHERE incident_id = ? AND event_type = 'PROVIDER_EVIDENCE_REOBSERVED'`,
        [incident.id],
      ),
    ).toEqual({ count: 0 });
    expect(failureInjected()).toBe(true);
  });

  it("accepts an empty create_sub_agent response after correlated provider evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);

    const client = createClient(
      makeStream({
        includeEmptySpawnResponse: true,
      }),
    );

    const service = createProviderInvestigationService(
      database,
      client,
      environment,
      () => "2026-08-25T09:59:00.000Z",
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result).toMatchObject({
      incidentId: incident.id,
      trueForgeSessionId: "existing-session",
      turnId: "turn-1",
      providerInvestigatorThreadId: "provider-thread-1",
      evidenceDisposition: "CAPTURED",
      providerStatusCode: 500,
    });

    const evidence = createProviderEvidenceService(
      database,
      null,
    ).getByIncidentId(incident.id);

    expect(evidence).toMatchObject({
      providerDeliveryId: deliveryId,
      deliveryGuid: "logical-guid-1",
      outcome: {
        statusCode: 500,
      },
    });

    const events = service.getWorkflowEvents(incident.id);

    expect(events.map((event) => event.eventType)).toEqual([
      "PROVIDER_INVESTIGATION_STARTED",
      "PROVIDER_INVESTIGATOR_STARTED",
      "PROVIDER_EVIDENCE_CAPTURED",
    ]);

    expect(events[2]).toMatchObject({
      trueForgeEventId: "tool-response-event",
      toolCallId: "github-call-1",
    });
  });
});

describe("TrueForge GitHub tool.response extraction", () => {
  it("accepts the installed runtime's direct JSON text content only", () => {
    const result = makeGithubResult();
    expect(
      extractGithubDeliveryFromTrueForgeToolResponse(JSON.stringify(result)),
    ).toEqual(result);
  });

  it("preserves an opaque delivery ID when the MCP text encodes it as an unsafe integer", () => {
    const content = JSON.stringify(makeGithubResult()).replace(
      `"id":"${deliveryId}"`,
      `"id":${deliveryId}`,
    );
    const result = extractGithubDeliveryFromTrueForgeToolResponse(content) as {
      full: { body: { id: unknown } };
    };

    expect(result.full.body.id).toBe(deliveryId);
  });

  it("rejects prose and alternative wrapper representations", () => {
    for (const content of [
      "GitHub returned HTTP 500",
      JSON.stringify({ content: [{ type: "text", text: JSON.stringify(makeGithubResult()) }] }),
      JSON.stringify({ structuredContent: makeGithubResult() }),
    ]) {
      expect(() =>
        extractGithubDeliveryFromTrueForgeToolResponse(content),
      ).toThrow(ProviderInvestigationEvidenceError);
    }
  });
});
