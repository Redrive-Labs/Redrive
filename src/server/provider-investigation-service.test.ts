import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getConnectionRecoveryCoordinatorAgentSpec,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
  RecoveryCoordinatorConfigurationError,
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
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
  PROVIDER_INVESTIGATOR_NAME,
} from "@/server/provider-investigation-service";
import {
  TrueForgeSessionSpecUpgradeError,
  TrueForgeSessionUnavailableError,
} from "@/server/trueforge-session-service";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";

const deliveryId = "900719925474099312345678901234567890";
const repositoryId = "example/receiver";
const connectionMcpServerName = "redrive-github";
const environment = {
  NODE_ENV: "test",
  REDRIVE_TRUEFORGE_MODEL: "configured-model",
  REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: connectionMcpServerName,
  REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "test-connection-mcp-token",
  REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: "redrive-receiver",
  REDRIVE_RECEIVER_MCP_TOKEN: "test-receiver-mcp-token",
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
  providerToolShape?: "direct-mcp" | "truefoundry-system-wrapper";
  toolName?: string;
  toolInfoName?: string;
  toolInfoServerName?: string;
  connectionArgument?: string;
  deliveryArgument?: string;
  providerArgumentsText?: string;
  extraArguments?: Record<string, unknown>;
  wrapperMcpServer?: string;
  wrapperToolName?: string;
  wrapperConnectionArgument?: string;
  wrapperDeliveryArgument?: string;
  wrapperExtraOuterField?: boolean;
  wrapperMissingOuterField?: "mcp_server" | "tool_name" | "input";
  wrapperExtraInnerField?: boolean;
  wrapperMissingInnerField?: "connection_id" | "delivery_id";
  extraProviderToolCall?: boolean;
  expectedDeliveryId?: string;
  turnId?: string;
  providerThreadId?: string;
  providerToolCallId?: string;
  providerSpawnToolCallId?: string;
  includeResponse?: boolean;
  includeRootToolCall?: boolean;
  includeEmptySpawnResponse?: boolean;
  responseThreadId?: string;
  responseToolCallId?: string;
  responseContent?: string;
  eventSuffix?: string;
  skillBootstraps?: SkillBootstrapOptions[];
  schemaIntrospections?: SchemaIntrospectionOptions[];
}

interface SchemaIntrospectionOptions {
  thread?: "root" | "child";
  toolCallId?: string;
  includeResponse?: boolean;
}

interface SkillBootstrapOptions {
  shape?: "exec" | "read-file";
  path?: string;
  command?: string;
  intent?: string;
  thread?: "root" | "child";
  toolCallId?: string;
  responseContent?: string;
  includeResponse?: boolean;
  responseThreadId?: string;
  responseToolCallId?: string;
}

const providerSkillPath =
  "/opt/tf/skills/redrive-connection-provider-investigation/SKILL.md";
const receiverSkillPath =
  "/opt/tf/skills/redrive-connection-receiver-investigation/SKILL.md";

function makeStream(
  options: StreamOptions = {},
): AsyncIterable<TrueForgeApi.TurnStreamingEvent> & { events: unknown[] } {
  const providerThreadId = options.providerThreadId ?? "provider-thread-1";
  const toolCallId = options.providerToolCallId ?? "github-call-1";
  const providerSpawnToolCallId =
    options.providerSpawnToolCallId ?? "spawn-provider-1";
  const turnId = options.turnId ?? "turn-1";
  const directProviderToolArguments = {
    connection_id: options.connectionArgument ?? "connection-1",
    delivery_id:
      options.deliveryArgument ?? options.expectedDeliveryId ?? deliveryId,
    ...options.extraArguments,
  };
  const wrapperInput: Record<string, unknown> = {
    connection_id: options.wrapperConnectionArgument ?? "connection-1",
    delivery_id:
      options.wrapperDeliveryArgument ?? options.expectedDeliveryId ?? deliveryId,
  };
  if (options.wrapperExtraInnerField) {
    wrapperInput.extra = "not-allowed";
  }
  if (options.wrapperMissingInnerField !== undefined) {
    delete wrapperInput[options.wrapperMissingInnerField];
  }
  const wrapperArguments: Record<string, unknown> = {
    mcp_server: options.wrapperMcpServer ?? connectionMcpServerName,
    tool_name: options.wrapperToolName ?? "get_webhook_delivery",
    input: wrapperInput,
  };
  if (options.wrapperExtraOuterField) {
    wrapperArguments.extra = "not-allowed";
  }
  if (options.wrapperMissingOuterField !== undefined) {
    delete wrapperArguments[options.wrapperMissingOuterField];
  }
  const isProviderToolWrapper =
    options.providerToolShape === "truefoundry-system-wrapper";
  const providerToolArgumentsText =
    options.providerArgumentsText ??
    JSON.stringify(
      isProviderToolWrapper
        ? wrapperArguments
        : directProviderToolArguments,
    );
  const providerToolCall = {
    id: toolCallId,
    type: "function",
    function: {
      name: isProviderToolWrapper
        ? "call_tool"
        : options.toolName ?? "get_webhook_delivery",
      arguments: providerToolArgumentsText,
    },
    toolInfo: isProviderToolWrapper
      ? {
          type: "truefoundry-system",
          name: "call_tool",
        }
      : {
          type: "mcp",
          name: options.toolInfoName ?? "get_webhook_delivery",
          serverId: "mcp-server-1",
          serverName: options.toolInfoServerName ?? connectionMcpServerName,
        },
  };
  const providerToolCalls: Record<string, unknown>[] = [providerToolCall];
  if (options.extraProviderToolCall) {
    providerToolCalls.push({ ...providerToolCall, id: "github-call-2" });
  }
  const events: unknown[] = [
    {
      type: "turn.created",
      id: "turn-created-event",
      turnId,
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
          id: providerSpawnToolCallId,
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
      parent: { threadId: "main", toolCallId: providerSpawnToolCallId },
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
      toolCalls: providerToolCalls,
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
              connection_id: options.connectionArgument ?? "connection-1",
              delivery_id:
                options.deliveryArgument ?? options.expectedDeliveryId ?? deliveryId,
            }),
          },
          toolInfo: {
            type: "mcp",
            name: "get_webhook_delivery",
            serverId: "mcp-server-1",
            serverName: options.toolInfoServerName ?? connectionMcpServerName,
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
        toolCallId: providerSpawnToolCallId,
        content: "",
      },
    );
  }
  for (const [index, bootstrap] of (options.skillBootstraps ?? []).entries()) {
    const toolCallId = bootstrap.toolCallId ?? `skill-bootstrap-${index + 1}`;
    const path = bootstrap.path ?? providerSkillPath;
    const shape = bootstrap.shape ?? "exec";
    const threadId = bootstrap.thread === "root" ? "main" : providerThreadId;
    const functionName = shape === "exec" ? "exec" : "read_file";
    const argumentsValue =
      shape === "exec"
        ? {
            command: bootstrap.command ?? `cat ${path}`,
            ...(bootstrap.intent === undefined
              ? {}
              : { intent: bootstrap.intent }),
          }
        : { path };
    events.push({
      type: "model.message",
      id: `skill-bootstrap-model-event-${index + 1}`,
      threadId,
      content: null,
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: functionName,
            arguments: JSON.stringify(argumentsValue),
          },
          toolInfo: {
            type: "truefoundry-system",
            name: functionName,
          },
        },
      ],
    });
    if (bootstrap.includeResponse !== false) {
      events.push({
        type: "tool.response",
        id: `skill-bootstrap-response-event-${index + 1}`,
        createdAt: "2026-08-25T10:00:02.750Z",
        threadId: bootstrap.responseThreadId ?? threadId,
        toolCallId: bootstrap.responseToolCallId ?? toolCallId,
        content: bootstrap.responseContent ?? "skill bootstrap complete",
      });
    }
  }
  for (const [index, introspection] of (
    options.schemaIntrospections ?? []
  ).entries()) {
    const toolCallId =
      introspection.toolCallId ?? `schema-introspection-${index + 1}`;
    const threadId =
      introspection.thread === "root" ? "main" : providerThreadId;
    events.push({
      type: "model.message",
      id: `schema-introspection-model-event-${index + 1}`,
      threadId,
      content: null,
      toolCalls: [
        {
          id: toolCallId,
          type: "function",
          function: {
            name: "get_tool_output_schema",
            arguments: JSON.stringify({ tool_name: "get_webhook_delivery" }),
          },
          toolInfo: {
            type: "truefoundry-system",
            name: "get_tool_output_schema",
          },
        },
      ],
    });
    if (introspection.includeResponse !== false) {
      events.push({
        type: "tool.response",
        id: `schema-introspection-response-event-${index + 1}`,
        createdAt: "2026-08-25T10:00:02.875Z",
        threadId,
        toolCallId,
        content: JSON.stringify({ type: "object" }),
      });
    }
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
  if (options.eventSuffix !== undefined) {
    for (const event of events) {
      if (
        event !== null &&
        typeof event === "object" &&
        "id" in event &&
        typeof event.id === "string"
      ) {
        event.id = `${event.id}-${options.eventSuffix}`;
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
    getSession: vi
      .fn()
      .mockImplementation(async (sessionId: string) => ({ id: sessionId })),
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
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connection-provider-investigation-"));
    database = openDatabase(path.join(directory, "incidents.sqlite"));
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: false });
  });

  function createIncident(externalDeliveryId = deliveryId) {
    const incident = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId,
      repositoryId,
    }).incident;
    const suffix = incident.id.replace(/[^a-zA-Z0-9]/g, "");
    database.run(
      `INSERT INTO github_app_registrations
        (id, github_app_id, slug, owner_id, owner_login, owner_type,
         private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`app-${suffix}`, `app-id-${suffix}`, "redrive", "owner-id", "octocat", "User", `key-${suffix}`, "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT INTO github_installations
        (installation_id, app_registration_id, account_id, account_login,
         account_type, repository_selection, last_verified_at, created_at,
         updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [`installation-${suffix}`, `app-${suffix}`, "owner-id", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"],
    );
    database.run(
      `INSERT OR IGNORE INTO application_connections
        (id, provider, github_installation_id, repository_id,
         repository_full_name, webhook_id, webhook_target_display, state,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["connection-1", "github", `installation-${suffix}`, repositoryId, repositoryId, `hook-${suffix}`, "https://receiver.example/webhook", "READY", "2026-01-01", "2026-01-01"],
    );
    database.run("UPDATE incidents SET application_connection_id = ? WHERE id = ?", ["connection-1", incident.id]);
    return { ...incident, applicationConnectionId: "connection-1" };
  }

  function installActiveBinding(
    incidentId: string,
    sessionId = "existing-session",
    coordinatorSpecVersion: string = CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
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

  it("uses the durable connection tuple before any TrueForge turn", async () => {
    const incident = createIncident("connection-delivery");
    const client = createClient(
      makeStream({
        connectionArgument: "connection-1",
        deliveryArgument: "connection-delivery",
        toolInfoServerName: connectionMcpServerName,
        responseContent: JSON.stringify(makeGithubResult({ id: "connection-delivery" })),
      }),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result).toMatchObject({
      incidentId: incident.id,
      providerStatusCode: 500,
      trueForgeSessionId: "replacement-session",
    });
    expect(client.createSession).toHaveBeenCalledOnce();
    expect(client.createTurnStream).toHaveBeenCalledOnce();
    expect(client.createSession.mock.calls[0][0].mcpServers).toEqual([
      expect.objectContaining({ name: connectionMcpServerName }),
      expect.objectContaining({ name: "redrive-receiver" }),
    ]);
    expect(client.listTurnEvents).toHaveBeenCalledWith(
      "replacement-session",
      "turn-1",
    );
    const turnInput = client.createTurnStream.mock.calls[0][1]?.input;
    expect(JSON.stringify(turnInput)).toContain("connection-1");
    expect(JSON.stringify(turnInput)).toContain("connection_id");
    expect(JSON.stringify(turnInput)).toContain("delivery_id");
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM provider_evidence",
      )?.count,
    ).toBe(1);
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

  it("rejects persisted events for a different turn and does not persist their evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);

    const persisted = makeStream();
    const liveEvents = persisted.events
      .filter(
        (event) =>
          event !== null &&
          typeof event === "object" &&
          "type" in event &&
          (event.type === "turn.created" || event.type === "turn.done"),
      )
      .map((event) =>
        event !== null &&
        typeof event === "object" &&
        "type" in event &&
        event.type === "turn.created"
          ? { ...event, turnId: "turn-A" }
          : event,
      );
    const persistedEvents = persisted.events.map((event) =>
      event !== null &&
      typeof event === "object" &&
      "type" in event &&
      event.type === "turn.created"
        ? { ...event, turnId: "turn-B" }
        : event,
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
    client.listTurnEvents.mockResolvedValue(
      persistedTurnEvents(persistedEvents),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);

    expect(
      createProviderEvidenceService(database).getByIncidentId(incident.id),
    ).toBeNull();
    expect(
      service
        .getWorkflowEvents(incident.id)
        .find((event) => event.eventType === "PROVIDER_INVESTIGATION_FAILED"),
    ).toMatchObject({
      eventType: "PROVIDER_INVESTIGATION_FAILED",
      trueForgeSessionId: "existing-session",
      turnId: "turn-A",
      details: {
        reason: "ProviderInvestigationTurnError",
        sourceTrueForgeEventId: "turn-created-event",
      },
    });
  });

  it("reuses the current existing session, then reobserves immutable evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const evidenceService = createProviderEvidenceService(database, () =>
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
    expect(client.updateSession).toHaveBeenCalledWith(
      "existing-session",
      getConnectionRecoveryCoordinatorAgentSpec(environment),
    );
    expect(client.createTurnStream).toHaveBeenCalledWith(
      "existing-session",
      expect.objectContaining({
        input: [
          expect.objectContaining({
            content: expect.stringContaining("connection_id=connection-1"),
          }),
        ],
      }),
    );
    expect(
      database.get<{ coordinator_spec_version: string }>(
        "SELECT coordinator_spec_version FROM trueforge_session_bindings WHERE incident_id = ?",
        [incident.id],
      ),
    ).toEqual({ coordinator_spec_version: CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION });
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

  it("reconciles the current v2 AgentSpec binding on the existing session", async () => {
    const incident = createIncident();
    installActiveBinding(
      incident.id,
      "existing-v2-session",
      CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
    );
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(database, client, environment);

    await service.investigateProviderForIncident(incident.id);

    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.updateSession).toHaveBeenCalledWith(
      "existing-v2-session",
      getConnectionRecoveryCoordinatorAgentSpec(environment),
    );
  });

  it("uses one turn for a valid first attempt and does not retry", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream());
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result.evidenceDisposition).toBe("CAPTURED");
    expect(client.createTurnStream).toHaveBeenCalledOnce();
    expect(client.listTurnEvents).toHaveBeenCalledOnce();
  });

  const acceptedSkillBootstrapCases: Array<
    [string, SkillBootstrapOptions[]]
  > = [
    [
      "one child exec read with intent",
      [{ path: providerSkillPath, intent: "load provider investigation skill" }],
    ],
    [
      "both exact Redrive exec reads",
      [
        { path: providerSkillPath },
        { path: receiverSkillPath },
      ],
    ],
    [
      "read_file bootstrap",
      [{ shape: "read-file", path: receiverSkillPath }],
    ],
    [
      "root and child bootstrap reads in varying order",
      [
        { path: receiverSkillPath, thread: "root" },
        { path: providerSkillPath, thread: "child" },
      ],
    ],
    [
      "eight duplicate bounded bootstrap reads",
      Array.from({ length: 8 }, () => ({ path: providerSkillPath })),
    ],
  ];

  it.each(acceptedSkillBootstrapCases)(
    "accepts %s alongside exactly one provider evidence call",
    async (_description, skillBootstraps) => {
      const incident = createIncident();
      installActiveBinding(incident.id);
      const client = createClient(makeStream({ skillBootstraps }));
      const service = createProviderInvestigationService(
        database,
        client,
        environment,
      );

      const result = await service.investigateProviderForIncident(incident.id);

      expect(result.evidenceDisposition).toBe("CAPTURED");
      expect(result.providerStatusCode).toBe(500);
      expect(
        createProviderEvidenceService(database).getByIncidentId(incident.id),
      ).toMatchObject({ providerDeliveryId: deliveryId });
    },
  );

  const rejectedSkillBootstrapCases: Array<
    [string, SkillBootstrapOptions[]]
  > = [
    ["arbitrary exec", [{ command: "pwd" }]],
    ["cat of another path", [{ command: "cat /tmp/other-skill.md" }]],
    [
      "shell syntax in exec",
      [{ command: `cat ${providerSkillPath}; echo unsafe | tee /tmp/x && true > /tmp/y < /tmp/z $() \`x\`` }],
    ],
    [
      "arbitrary read_file path",
      [{ shape: "read-file", path: "/tmp/supporting-file.txt" }],
    ],
    [
      "more than the bootstrap ceiling",
      Array.from({ length: 9 }, () => ({ path: providerSkillPath })),
    ],
    [
      "missing bootstrap response",
      [{ path: providerSkillPath, includeResponse: false }],
    ],
    [
      "mismatched bootstrap response",
      [{ path: providerSkillPath, responseToolCallId: "other-call" }],
    ],
  ];

  it.each(rejectedSkillBootstrapCases)(
    "rejects %s",
    async (_description, skillBootstraps) => {
      const incident = createIncident();
      installActiveBinding(incident.id);
      const client = createClient(makeStream({ skillBootstraps }));
      const service = createProviderInvestigationService(
        database,
        client,
        environment,
      );

      await expect(
        service.investigateProviderForIncident(incident.id),
      ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);
      expect(
        createProviderEvidenceService(database).getByIncidentId(incident.id),
      ).toBeNull();
    },
  );

  it.each([
    { mcp_server: connectionMcpServerName },
    { repository_id: repositoryId, webhook_id: "fabricated-hook" },
  ])(
    "retries an exact lookup tuple with fabricated extra keys (%s)",
    async (extraArguments) => {
      const incident = createIncident();
      installActiveBinding(incident.id);
      const first = makeStream({
        extraArguments,
        eventSuffix: "first",
      });
      const second = makeStream({
        turnId: "turn-2",
        providerThreadId: "provider-thread-2",
        providerToolCallId: "github-call-2",
        providerSpawnToolCallId: "spawn-provider-2",
        eventSuffix: "second",
      });
      const client = createClient(first);
      client.createTurnStream
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(second);
      client.listTurnEvents.mockImplementation((_sessionId, turnId) =>
        Promise.resolve(
          persistedTurnEvents(turnId === "turn-1" ? first.events : second.events),
        ),
      );
      const service = createProviderInvestigationService(
        database,
        client,
        environment,
      );

      const result = await service.investigateProviderForIncident(incident.id);

      expect(result).toMatchObject({
        turnId: "turn-2",
        providerInvestigatorThreadId: "provider-thread-2",
        evidenceDisposition: "CAPTURED",
      });
      expect(client.createTurnStream).toHaveBeenCalledTimes(2);
      expect(client.createTurnStream.mock.calls[0][0]).toBe("existing-session");
      expect(client.createTurnStream.mock.calls[1][0]).toBe("existing-session");
      expect(client.listTurnEvents).toHaveBeenNthCalledWith(
        2,
        "existing-session",
        "turn-2",
      );
      const retryInput = JSON.stringify(client.createTurnStream.mock.calls[1][1]?.input);
      expect(retryInput).toContain("previous provider investigation attempt was rejected");
      expect(retryInput).toContain("added extra argument keys");
      expect(retryInput).toContain(
        JSON.stringify(
          `EXACTLY: {"connection_id":"connection-1","delivery_id":"${deliveryId}"}`,
        ).slice(1, -1),
      );
      expect(retryInput).toContain("no other properties");

      const events = service.getWorkflowEvents(incident.id);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: "PROVIDER_INVESTIGATION_FAILED",
            turnId: "turn-1",
            details: expect.objectContaining({
              attempt: 1,
              retryEligible: true,
              reason: "ProviderInvestigationUnexpectedArgumentsError",
            }),
          }),
          expect.objectContaining({
            eventType: "PROVIDER_EVIDENCE_CAPTURED",
            turnId: "turn-2",
            trueForgeEventId: "tool-response-event-second",
            toolCallId: "github-call-2",
          }),
        ]),
      );
      expect(events.map((event) => event.trueForgeEventId)).not.toContain(
        "tool-response-event-first",
      );
    },
  );

  it("does not retry an extra-key attempt when the second attempt also fails", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const first = makeStream({
      extraArguments: { repository_id: repositoryId },
      eventSuffix: "first",
    });
    const second = makeStream({
      extraArguments: { webhook_id: "fabricated-hook" },
      turnId: "turn-2",
      providerThreadId: "provider-thread-2",
      providerToolCallId: "github-call-2",
      providerSpawnToolCallId: "spawn-provider-2",
      eventSuffix: "second",
    });
    const client = createClient(first);
    client.createTurnStream
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);
    client.listTurnEvents.mockImplementation((_sessionId, turnId) =>
      Promise.resolve(
        persistedTurnEvents(turnId === "turn-1" ? first.events : second.events),
      ),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);

    expect(client.createTurnStream).toHaveBeenCalledTimes(2);
    expect(createProviderEvidenceService(database).getByIncidentId(incident.id)).toBeNull();
    expect(
      service
        .getWorkflowEvents(incident.id)
        .filter((event) => event.eventType === "PROVIDER_INVESTIGATION_FAILED"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          details: expect.objectContaining({
            attempt: 1,
            retryEligible: true,
            reason: "ProviderInvestigationUnexpectedArgumentsError",
          }),
        }),
        expect.objectContaining({
          turnId: "turn-2",
          providerInvestigatorThreadId: "provider-thread-2",
          toolCallId: "github-call-2",
          details: expect.objectContaining({
            attempt: 2,
            retryEligible: false,
            reason: "ProviderInvestigationUnexpectedArgumentsError",
          }),
        }),
      ]),
    );
  });

  it.each([
    ["missing connection_id", JSON.stringify({ delivery_id: deliveryId })],
    ["missing delivery_id", JSON.stringify({ connection_id: "connection-1" })],
    ["invalid JSON", "not-json"],
    ["non-object JSON", JSON.stringify(["connection-1", deliveryId])],
  ])("does not retry %s arguments", async (_description, providerArgumentsText) => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream({ providerArgumentsText }));
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);
    expect(client.createTurnStream).toHaveBeenCalledOnce();
  });

  it("accepts the existing direct MCP form and captures first evidence", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream({ providerToolShape: "direct-mcp" }));
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
      () => "2026-08-25T10:00:04.000Z",
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result.evidenceDisposition).toBe("CAPTURED");
    const evidence = createProviderEvidenceService(database).getByIncidentId(
      incident.id,
    );
    expect(evidence).toMatchObject({
      providerDeliveryId: deliveryId,
      deliveryGuid: "logical-guid-1",
      outcome: { statusCode: 500 },
    });
  });

  it("accepts the live TrueForge call_tool provider wrapper", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(
      makeStream({ providerToolShape: "truefoundry-system-wrapper" }),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    const result = await service.investigateProviderForIncident(incident.id);

    expect(result).toMatchObject({
      evidenceDisposition: "CAPTURED",
      providerInvestigatorThreadId: "provider-thread-1",
      providerStatusCode: 500,
    });
    expect(
      createProviderEvidenceService(database).getByIncidentId(incident.id),
    ).toMatchObject({
      providerDeliveryId: deliveryId,
      deliveryGuid: "logical-guid-1",
    });
  });

  it("accepts bounded child-only TrueForge schema introspection before the single evidence call", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(
      makeStream({ schemaIntrospections: [{}] }),
    );
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).resolves.toMatchObject({
      evidenceDisposition: "CAPTURED",
      providerStatusCode: 500,
    });
  });

  it("rejects schema introspection from the root or without a correlated response", async () => {
    for (const [index, schemaIntrospections] of [
      [{ thread: "root" as const }],
      [{ includeResponse: false }],
    ].entries()) {
      const incident = createIncident(`${deliveryId}-schema-${index}`);
      installActiveBinding(incident.id, `schema-session-${index}`);
      const client = createClient(
        makeStream({
          expectedDeliveryId: incident.externalDeliveryId,
          schemaIntrospections,
        }),
      );
      const service = createProviderInvestigationService(
        database,
        client,
        environment,
      );

      await expect(
        service.investigateProviderForIncident(incident.id),
      ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);
    }
  });

  it("fails before remote session work when connection MCP configuration is unavailable", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id, "existing-session");
    const client = createClient(makeStream());
    const environmentWithoutMcp: NodeJS.ProcessEnv = { ...environment };
    delete environmentWithoutMcp.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
    const service = createProviderInvestigationService(
      database,
      client,
      environmentWithoutMcp,
    );

    await expect(service.investigateProviderForIncident(incident.id)).rejects.toBeInstanceOf(
      RecoveryCoordinatorConfigurationError,
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

  it("does not start a turn when prior session spec reconciliation fails", async () => {
    const incident = createIncident();
    installActiveBinding(
      incident.id,
      "v2-session",
      "m2.6b-v1",
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
    ).toEqual({ coordinator_spec_version: "m2.6b-v1" });
  });

  it("rejects root-thread calls, wrong subagents, wrong MCP resources, and wrong IDs", async () => {
    const cases: StreamOptions[] = [
      { modelThreadId: "main" },
      { agentName: "other-investigator" },
      { toolInfoServerName: "other-server" },
      { toolInfoServerName: "redrive-receiver" },
      { toolName: "redeliver_webhook_delivery", toolInfoName: "redeliver_webhook_delivery" },
      { connectionArgument: "wrong-connection" },
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
      expect(client.createTurnStream).toHaveBeenCalledOnce();
      expect(
        createProviderEvidenceService(database).getByIncidentId(incident.id),
      ).toBeNull();
    }
  });

  it.each([
    [
      "wrong wrapper MCP server",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperMcpServer: "other-server",
      },
    ],
    [
      "wrong wrapper tool name",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperToolName: "redeliver_webhook_delivery",
      },
    ],
    [
      "extra wrapper key",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperExtraOuterField: true,
      },
    ],
    [
      "missing wrapper key",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperMissingOuterField: "input",
      },
    ],
    [
      "extra inner input key",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperExtraInnerField: true,
      },
    ],
    [
      "wrong wrapper connection ID",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperConnectionArgument: "wrong-connection",
      },
    ],
    [
      "wrong wrapper delivery ID",
      {
        providerToolShape: "truefoundry-system-wrapper",
        wrapperDeliveryArgument: "wrong-delivery",
      },
    ],
    [
      "more than one provider child tool call",
      {
        providerToolShape: "truefoundry-system-wrapper",
        extraProviderToolCall: true,
      },
    ],
    [
      "mismatched tool.response",
      {
        responseThreadId: "main",
        responseToolCallId: "not-provider-call",
      },
    ],
  ] as const)("rejects %s", async (_description, options) => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const client = createClient(makeStream(options));
    const service = createProviderInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateProviderForIncident(incident.id),
    ).rejects.toBeInstanceOf(ProviderInvestigationTurnError);
    expect(
      createProviderEvidenceService(database).getByIncidentId(incident.id),
    ).toBeNull();
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
      createProviderEvidenceService(database).getByIncidentId(incident.id),
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

    const proseIncident = createIncident("prose-delivery");
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
      createProviderEvidenceService(database).getByIncidentId(proseIncident.id),
    ).toBeNull();
  });

  it("records conflict and leaves the original immutable snapshot untouched", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id);
    const evidenceService = createProviderEvidenceService(database, () =>
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
      createProviderEvidenceService(database).getByIncidentId(incident.id),
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
      createProviderEvidenceService(database).getByIncidentId(incident.id),
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
    const evidenceService = createProviderEvidenceService(database, () =>
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

    const evidence = createProviderEvidenceService(database).getByIncidentId(incident.id);

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
