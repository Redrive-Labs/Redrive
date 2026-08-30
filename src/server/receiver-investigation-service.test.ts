import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION } from "@/agents/recovery-coordinator";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import {
  buildReceiverInvestigationInput,
  buildReceiverInvestigatorTask,
  collectReceiverTurn,
  createReceiverInvestigationService,
  extractBusinessStateFromTrueForgeToolResponse,
  RECEIVER_INVESTIGATOR_NAME,
  ReceiverInvestigationConfigurationError,
  ReceiverInvestigationEvidenceError,
  ReceiverInvestigationTurnError,
} from "@/server/receiver-investigation-service";
import { TrueForgeSessionMismatchError } from "@/server/trueforge-session-service";

const applicationConnectionId = "application-connection-1";
const receiverMcpServerName = "redrive-receiver";
const sessionId = "session-1";
const deliveryGuid = "receiver-delivery-guid-1";
const observedAt = "2026-08-30T00:00:02.000Z";
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  NODE_ENV: "test",
  REDRIVE_TRUEFORGE_MODEL: "configured-model",
  REDRIVE_TRUEFORGE_CONNECTION_GITHUB_MCP_NAME: "redrive-github",
  REDRIVE_GITHUB_CONNECTION_MCP_TOKEN: "github-token",
  REDRIVE_TRUEFORGE_CONNECTION_RECEIVER_MCP_NAME: receiverMcpServerName,
  REDRIVE_RECEIVER_MCP_TOKEN: "receiver-token",
};

interface ReceiverEventOptions {
  turnId?: string;
  persistedTurnId?: string;
  agentName?: string;
  parentInput?: string;
  childInput?: string;
  childThreadId?: string;
  receiverToolShape?: "direct-mcp" | "truefoundry-system-wrapper";
  toolServerName?: string;
  toolName?: string;
  functionName?: string;
  toolArguments?: string;
  wrapperMcpServer?: string;
  wrapperToolName?: string;
  wrapperConnectionId?: string;
  wrapperDeliveryGuid?: string;
  wrapperExtraOuterField?: boolean;
  wrapperExtraInnerField?: boolean;
  responseThreadId?: string;
  responseToolCallId?: string;
  responseContent?: string;
  duplicateToolCall?: boolean;
  duplicateResponse?: boolean;
  duplicateEventId?: boolean;
  duplicateThreadId?: boolean;
  duplicateToolCallId?: boolean;
  includeRootReceiverCall?: boolean;
  extraRootCreateCall?: boolean;
  extraThread?: boolean;
}

function iterable<T>(items: unknown[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item as T;
    },
  };
}

function businessResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    deliveryGuid,
    mutationCount: 1,
    businessState: "EXACTLY_ONE",
    observedAt,
    ...overrides,
  });
}

function receiverEvents(options: ReceiverEventOptions = {}): unknown[] {
  const turnId = options.turnId ?? "receiver-turn-1";
  const persistedTurnId = options.persistedTurnId ?? turnId;
  const childThreadId = options.childThreadId ?? "receiver-thread-1";
  const eventSuffix = turnId === "receiver-turn-1" ? "" : `-${turnId}`;
  const spawnToolCallId = `spawn-receiver-1${eventSuffix}`;
  const receiverToolCallId = `receiver-call-1${eventSuffix}`;
  const task = buildReceiverInvestigatorTask(
    applicationConnectionId,
    deliveryGuid,
  );
  const parentInput = options.parentInput ?? task;
  const childInput = options.childInput ?? parentInput;
  const rootToolCalls: Record<string, unknown>[] = [
    {
      id: spawnToolCallId,
      type: "function",
      function: {
        name: "create_sub_agent",
        arguments: JSON.stringify({
          name: options.agentName ?? RECEIVER_INVESTIGATOR_NAME,
          input: parentInput,
        }),
      },
      toolInfo: {
        type: "truefoundry-system",
        name: "create_sub_agent",
      },
    },
  ];
  if (options.extraRootCreateCall) {
    rootToolCalls.push({
      id: "spawn-receiver-2",
      type: "function",
      function: {
        name: "create_sub_agent",
        arguments: JSON.stringify({
          name: RECEIVER_INVESTIGATOR_NAME,
          input: task,
        }),
      },
      toolInfo: {
        type: "truefoundry-system",
        name: "create_sub_agent",
      },
    });
  }
  if (options.includeRootReceiverCall) {
    rootToolCalls.push({
      id: "root-receiver-call",
      type: "function",
      function: {
        name: "get_business_state",
        arguments: JSON.stringify({
          connection_id: applicationConnectionId,
          delivery_guid: deliveryGuid,
        }),
      },
      toolInfo: {
        type: "mcp",
        name: "get_business_state",
        serverName: receiverMcpServerName,
      },
    });
  }

  const directArguments = JSON.stringify({
    connection_id: applicationConnectionId,
    delivery_guid: deliveryGuid,
  });
  const wrapperInput: Record<string, unknown> = {
    connection_id: options.wrapperConnectionId ?? applicationConnectionId,
    delivery_guid: options.wrapperDeliveryGuid ?? deliveryGuid,
  };
  if (options.wrapperExtraInnerField) wrapperInput.extra = "not-allowed";
  const wrapperArguments: Record<string, unknown> = {
    mcp_server: options.wrapperMcpServer ?? receiverMcpServerName,
    tool_name: options.wrapperToolName ?? "get_business_state",
    input: wrapperInput,
  };
  if (options.wrapperExtraOuterField) wrapperArguments.extra = "not-allowed";
  const isWrapper =
    options.receiverToolShape === "truefoundry-system-wrapper";
  const receiverToolCall = {
    id: receiverToolCallId,
    type: "function",
    function: {
      name: isWrapper
        ? "call_tool"
        : options.functionName ?? options.toolName ?? "get_business_state",
      arguments:
        options.toolArguments ??
        (isWrapper ? JSON.stringify(wrapperArguments) : directArguments),
    },
    toolInfo: {
      type: isWrapper ? "truefoundry-system" : "mcp",
      name: isWrapper
        ? "call_tool"
        : options.toolName ?? "get_business_state",
      ...(isWrapper
        ? {}
        : { serverName: options.toolServerName ?? receiverMcpServerName }),
    },
  };

  const events: unknown[] = [
    {
      type: "turn.created",
      id: `turn-created-${turnId}`,
      turnId: persistedTurnId,
      state: { status: "running" },
      createdAt: "2026-08-30T00:00:00.000Z",
      threadId: null,
    },
    {
      type: "model.message",
      id: "receiver-spawn-model-event",
      threadId: "main",
      content: null,
      toolCalls: rootToolCalls,
    },
    {
      type: "thread.created",
      id: `receiver-thread-created-event${eventSuffix}`,
      threadId: childThreadId,
      title: "Receiver investigator",
      createdAt: "2026-08-30T00:00:01.000Z",
      parent: { threadId: "main", toolCallId: spawnToolCallId },
      agentInfo: {
        type: "dynamic",
        name: options.agentName ?? RECEIVER_INVESTIGATOR_NAME,
        input: childInput,
      },
    },
    {
      type: "model.message",
      id: `receiver-model-event${eventSuffix}`,
      threadId: childThreadId,
      content: null,
      toolCalls: [receiverToolCall],
    },
    {
      type: "tool.response",
      id: `receiver-tool-response-event${eventSuffix}`,
      createdAt: observedAt,
      threadId: options.responseThreadId ?? childThreadId,
      toolCallId: options.responseToolCallId ?? receiverToolCallId,
      content: options.responseContent ?? businessResult(),
    },
    {
      type: "model.message",
      id: `receiver-finished-model-event${eventSuffix}`,
      threadId: childThreadId,
      content: "Receiver investigation complete.",
      toolCalls: [],
    },
  ];

  if (options.duplicateToolCall) {
    events.splice(4, 0, {
      type: "model.message",
      id: "receiver-duplicate-model-event",
      threadId: childThreadId,
      content: null,
      toolCalls: [
        {
          ...receiverToolCall,
          id: options.duplicateToolCallId
            ? receiverToolCallId
            : "receiver-call-2",
        },
      ],
    });
  }
  if (options.duplicateResponse) {
    events.splice(5 + (options.duplicateToolCall ? 1 : 0), 0, {
      type: "tool.response",
      id: "receiver-tool-response-event-duplicate",
      createdAt: observedAt,
      threadId: childThreadId,
      toolCallId: receiverToolCallId,
      content: options.responseContent ?? businessResult(),
    });
  }
  if (options.extraThread) {
    events.splice(3, 0, {
      type: "thread.created",
      id: "distractor-thread-created-event",
      threadId: options.duplicateThreadId ? childThreadId : "distractor-thread",
      title: "Distractor",
      createdAt: "2026-08-30T00:00:01.100Z",
      parent: { threadId: "main", toolCallId: "spawn-distractor" },
      agentInfo: {
        type: "dynamic",
        name: "distractor-investigator",
        input: task,
      },
    });
  }

  events.push({
    type: "tool.response",
      id: `spawn-receiver-response-event${eventSuffix}`,
    createdAt: "2026-08-30T00:00:03.000Z",
    threadId: "main",
    toolCallId: spawnToolCallId,
    content: "",
  });
  events.push({
    type: "turn.done",
    id: `turn-done-${turnId}`,
    createdAt: "2026-08-30T00:00:04.000Z",
    threadId: null,
    state: { status: "done" },
  });
  if (options.duplicateEventId) {
    (events[1] as Record<string, unknown>).id =
      (events[0] as Record<string, unknown>).id;
  }
  return events;
}

function createClient(events: unknown[], liveTurnIdOverride?: string) {
  const liveTurnEvent = events.find(
    (event): event is { type: string; turnId?: unknown } =>
      typeof event === "object" &&
      event !== null &&
      "type" in event &&
      event.type === "turn.created",
  );
  const liveTurnId =
    liveTurnIdOverride ??
    (typeof liveTurnEvent?.turnId === "string"
      ? liveTurnEvent.turnId
      : "receiver-turn-1");
  return {
    createSession: vi.fn().mockResolvedValue("replacement-session"),
    getSession: vi.fn().mockResolvedValue({ id: sessionId }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    createTurnStream: vi.fn().mockResolvedValue(
      iterable<TrueForgeApi.TurnStreamingEvent>([
        {
          type: "turn.created",
          id: "live-turn-created",
          turnId: liveTurnId,
          state: { status: "running" },
        },
        {
          type: "turn.done",
          id: "live-turn-done",
          state: { status: "done" },
        },
      ]),
    ),
    listTurnEvents: vi.fn().mockResolvedValue(
      iterable<TrueForgeApi.SessionEvent>(events),
    ),
  };
}

describe("TrueForge receiver investigation", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-receiver-investigation-"));
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

  function createIncident(suffix = crypto.randomUUID()): string {
    const incident = createIncidentService(database).create({
      provider: "github",
      externalDeliveryId: `provider-delivery-${suffix}`,
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
       VALUES (?, 'ACTIVE', ?, NULL, ?, ?, ?)`,
      [
        incident.id,
        sessionId,
        CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
        observedAt,
        observedAt,
      ],
    );
    return incident.id;
  }

  it("uses the deterministic tuple, one receiver child, one MCP call, and the same active session", async () => {
    const incidentId = createIncident();
    const events = receiverEvents();
    const client = createClient(events);
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
      () => observedAt,
    );

    const result = await service.investigateReceiverForIncident(incidentId, {
      connectionId: applicationConnectionId,
      deliveryGuid,
      expectedSessionId: sessionId,
    });

    expect(result).toMatchObject({
      incidentId,
      trueForgeSessionId: sessionId,
      turnId: "receiver-turn-1",
      receiverInvestigatorThreadId: "receiver-thread-1",
      observationDisposition: "CAPTURED",
      observation: {
        incidentId,
        applicationConnectionId,
        deliveryGuid,
        mutationCount: 1,
        businessState: "EXACTLY_ONE",
        toolResponseEventId: "receiver-tool-response-event",
      },
    });
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.getSession).toHaveBeenCalledWith(sessionId);
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).toHaveBeenCalledWith(sessionId, {
      input: buildReceiverInvestigationInput(
        applicationConnectionId,
        deliveryGuid,
      ),
    });
    expect(client.listTurnEvents).toHaveBeenCalledWith(
      sessionId,
      "receiver-turn-1",
    );
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations WHERE incident_id = ?",
        [incidentId],
      ),
    ).toEqual({ count: 1 });
  });

  it("accepts the live TrueForge call_tool receiver wrapper", async () => {
    const incidentId = createIncident();
    const client = createClient(
      receiverEvents({ receiverToolShape: "truefoundry-system-wrapper" }),
    );
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
      () => observedAt,
    );

    const result = await service.investigateReceiverForIncident(incidentId, {
      connectionId: applicationConnectionId,
      deliveryGuid,
      expectedSessionId: sessionId,
    });

    expect(result.observation.businessState).toBe("EXACTLY_ONE");
    expect(result.observation.toolResponseEventId).toBe(
      "receiver-tool-response-event",
    );
  });

  it("accepts an expanded child task when parent and thread inputs match", async () => {
    const incidentId = createIncident();
    const expandedTask =
      "Investigate this receiver delivery in a self-contained task and return the authoritative business-state evidence.";
    const client = createClient(
      receiverEvents({ parentInput: expandedTask, childInput: expandedTask }),
    );
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
      () => observedAt,
    );

    const result = await service.investigateReceiverForIncident(incidentId, {
      connectionId: applicationConnectionId,
      deliveryGuid,
      expectedSessionId: sessionId,
    });

    expect(result.observation.businessState).toBe("EXACTLY_ONE");
  });

  it("does not create a replacement session and does not create a turn on reconciliation failure", async () => {
    const incidentId = createIncident();
    database.run(
      "UPDATE trueforge_session_bindings SET coordinator_spec_version = 'm2.6b-v1' WHERE incident_id = ?",
      [incidentId],
    );
    const client = createClient(receiverEvents());
    client.updateSession.mockRejectedValueOnce(new Error("CAS rejected"));
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateReceiverForIncident(incidentId, {
        connectionId: applicationConnectionId,
        deliveryGuid,
        expectedSessionId: sessionId,
      }),
    ).rejects.toThrow();
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations",
      ),
    ).toEqual({ count: 0 });
  });

  it("fails closed when the remote lookup does not prove the bound session identity", async () => {
    const incidentId = createIncident();
    const client = createClient(receiverEvents());
    client.getSession.mockResolvedValueOnce({ id: "different-session" });
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateReceiverForIncident(incidentId, {
        connectionId: applicationConnectionId,
        deliveryGuid,
        expectedSessionId: sessionId,
      }),
    ).rejects.toBeInstanceOf(TrueForgeSessionMismatchError);
    expect(client.createSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations",
      ),
    ).toEqual({ count: 0 });
  });

  it("does not create a receiver turn when the bound session becomes LOST during reconciliation", async () => {
    const incidentId = createIncident();
    const client = createClient(receiverEvents());
    client.getSession.mockImplementation(async () => {
      database.run(
        "UPDATE trueforge_session_bindings SET state = 'LOST' WHERE incident_id = ?",
        [incidentId],
      );
      return { id: sessionId };
    });
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateReceiverForIncident(incidentId, {
        connectionId: applicationConnectionId,
        deliveryGuid,
        expectedSessionId: sessionId,
      }),
    ).rejects.toThrow();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations",
      ),
    ).toEqual({ count: 0 });
  });

  it("fails before session or turn work when Receiver MCP configuration is missing", async () => {
    const incidentId = createIncident();
    const client = createClient(receiverEvents());
    const environmentWithoutReceiver: NodeJS.ProcessEnv = { ...environment };
    delete environmentWithoutReceiver.REDRIVE_RECEIVER_MCP_TOKEN;
    const service = createReceiverInvestigationService(
      database,
      client,
      environmentWithoutReceiver,
    );

    await expect(
      service.investigateReceiverForIncident(incidentId, {
        connectionId: applicationConnectionId,
        deliveryGuid,
        expectedSessionId: sessionId,
      }),
    ).rejects.toBeInstanceOf(ReceiverInvestigationConfigurationError);
    expect(client.getSession).not.toHaveBeenCalled();
    expect(client.updateSession).not.toHaveBeenCalled();
    expect(client.createTurnStream).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations",
      ),
    ).toEqual({ count: 0 });
  });

  it("creates a later append for a new turn on the same session", async () => {
    const incidentId = createIncident();
    const firstClient = createClient(receiverEvents());
    const service = createReceiverInvestigationService(
      database,
      firstClient,
      environment,
      () => observedAt,
    );
    await service.investigateReceiverForIncident(incidentId, {
      connectionId: applicationConnectionId,
      deliveryGuid,
      expectedSessionId: sessionId,
    });

    const secondEvents = receiverEvents({
      turnId: "receiver-turn-2",
      persistedTurnId: "receiver-turn-2",
    });
    const secondClient = createClient(secondEvents);
    const secondService = createReceiverInvestigationService(
      database,
      secondClient,
      environment,
      () => observedAt,
    );
    const result = await secondService.investigateReceiverForIncident(incidentId, {
      connectionId: applicationConnectionId,
      deliveryGuid,
      expectedSessionId: sessionId,
    });

    expect(result.observationDisposition).toBe("CAPTURED");
    expect(firstClient.createSession).not.toHaveBeenCalled();
    expect(secondClient.createSession).not.toHaveBeenCalled();
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations WHERE incident_id = ?",
        [incidentId],
      ),
    ).toEqual({ count: 2 });
  });

  it.each([
    ["historical turn", { persistedTurnId: "old-turn" }],
    ["distractor thread", { extraThread: true }],
    [
      "parent/thread input mismatch",
      { parentInput: "parent task", childInput: "different child task" },
    ],
    ["wrong server", { toolServerName: "other-receiver" }],
    ["wrong tool", { toolName: "get_receiver_health" }],
    ["root receiver call", { includeRootReceiverCall: true }],
    ["duplicate root create", { extraRootCreateCall: true }],
    ["duplicate tool call", { duplicateToolCall: true }],
    ["duplicate tool-call ID", { duplicateToolCall: true, duplicateToolCallId: true }],
    ["duplicate response", { duplicateResponse: true }],
    ["duplicate persisted event ID", { duplicateEventId: true }],
    ["duplicate dynamic thread ID", { extraThread: true, duplicateThreadId: true }],
    ["wrong MCP role", { toolServerName: "redrive-github" }],
    [
      "wrong wrapper mcp_server",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperMcpServer: "other-receiver",
      },
    ],
    [
      "wrong wrapper tool_name",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperToolName: "get_receiver_health",
      },
    ],
    [
      "extra wrapper outer field",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperExtraOuterField: true,
      },
    ],
    [
      "extra wrapper inner field",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperExtraInnerField: true,
      },
    ],
    [
      "wrong wrapper connection ID",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperConnectionId: "other-connection",
      },
    ],
    [
      "wrong wrapper delivery GUID",
      {
        receiverToolShape: "truefoundry-system-wrapper",
        wrapperDeliveryGuid: "other-delivery-guid",
      },
    ],
    [
      "wrong response pair",
      { responseThreadId: "main", responseToolCallId: "root-receiver-call" },
    ],
    [
      "wrong exact arguments",
      {
        toolArguments: JSON.stringify({
          connection_id: applicationConnectionId,
          delivery_guid: deliveryGuid,
          connector_id: "not-allowed",
        }),
      },
    ],
  ] as const)("rejects %s without persisting receiver evidence", async (_name, options) => {
    const incidentId = createIncident();
    const events = receiverEvents(options);
    const client = createClient(events, "receiver-turn-1");
    const service = createReceiverInvestigationService(
      database,
      client,
      environment,
    );

    await expect(
      service.investigateReceiverForIncident(incidentId, {
        connectionId: applicationConnectionId,
        deliveryGuid,
        expectedSessionId: sessionId,
      }),
    ).rejects.toBeInstanceOf(ReceiverInvestigationTurnError);
    expect(
      database.get<{ count: number }>(
        "SELECT COUNT(*) AS count FROM receiver_observations WHERE incident_id = ?",
        [incidentId],
      ),
    ).toEqual({ count: 0 });
  });

  it("rejects wrapped, prose, mismatched-guid, and count/state-mismatched responses", () => {
    const cases = [
      "Receiver completed successfully.",
      JSON.stringify({ jsonrpc: "2.0", result: { content: [{ text: businessResult() }] } }),
      businessResult({ deliveryGuid: "other-guid" }),
      businessResult({ mutationCount: 0, businessState: "EXACTLY_ONE" }),
    ];
    for (const content of cases) {
      expect(() =>
        extractBusinessStateFromTrueForgeToolResponse(content, deliveryGuid),
      ).toThrow(ReceiverInvestigationEvidenceError);
    }
  });
});
