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
  responseThreadId?: string;
  responseToolCallId?: string;
  responseContent?: string;
}

function makeStream(options: StreamOptions = {}): AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
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
    async *[Symbol.asyncIterator]() {
      for (const event of events) {
        yield event as TrueForgeApi.TurnStreamingEvent;
      }
    },
  };
}

function createClient(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
) {
  return {
    createSession: vi.fn().mockResolvedValue("replacement-session"),
    getSession: vi.fn().mockResolvedValue({ id: "existing-session" }),
    updateSession: vi.fn().mockResolvedValue(undefined),
    createTurnStream: vi.fn().mockResolvedValue(stream),
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
        LEGACY_RECOVERY_COORDINATOR_SPEC_VERSION,
        "2026-01-01T00:00:00.000Z",
        "2026-01-01T00:00:00.000Z",
      ],
    );
  }

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

  it("does not start a turn when the in-place session upgrade fails", async () => {
    const incident = createIncident();
    installActiveBinding(incident.id, "v1-session");
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
    ).toEqual({ coordinator_spec_version: LEGACY_RECOVERY_COORDINATOR_SPEC_VERSION });
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
    proseClient.createTurnStream.mockResolvedValue({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "turn.created",
          id: "turn-created-event-prose",
          turnId: "turn-prose",
          state: { status: "running" },
        } as never;
        yield {
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
        } as never;
        yield {
          type: "model.message",
          id: "prose-model-event",
          threadId: "provider-thread-prose",
          content: "GitHub returned HTTP 500",
        } as never;
        yield {
          type: "turn.done",
          id: "turn-done-event-prose",
          state: { status: "done" },
        } as never;
      },
    });
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
