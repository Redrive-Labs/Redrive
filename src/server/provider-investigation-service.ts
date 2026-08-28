import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  GITHUB_PROVIDER,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import {
  GITHUB_WEBHOOK_DELIVERY_TOOL,
  getRecoveryCoordinatorAgentSpec,
  PROVIDER_INVESTIGATION_SKILL_NAME,
} from "@/agents/recovery-coordinator";
import {
  GithubMcpConfigurationError,
  parseGithubMcpToolResultJson,
  resolveConfiguredGithubHookId,
} from "@/server/github-mcp";
import { createIncidentService } from "@/server/incident-service";
import {
  createIncidentWorkflowEventService,
  type AppendIncidentWorkflowEventInput,
} from "@/server/incident-workflow-event-service";
import {
  createProviderEvidenceService,
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
  UnsupportedProviderEvidenceError,
  type ProviderEvidenceCaptureResult,
} from "@/server/provider-evidence-service";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";
import {
  createConfiguredTrueForgeClient,
  type TrueForgeIncidentClient,
} from "@/server/trueforge-client";
import {
  createTrueForgeSessionService,
  TrueForgeSessionUnavailableError,
  type TrueForgeSessionEnsureResult,
} from "@/server/trueforge-session-service";

export const PROVIDER_INVESTIGATOR_NAME = "provider-investigator" as const;
const CREATE_SUB_AGENT_TOOL = "create_sub_agent" as const;

export class ProviderInvestigationConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderInvestigationConfigurationError";
  }
}

export class ProviderInvestigationTurnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderInvestigationTurnError";
  }
}

export class ProviderInvestigationEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ProviderInvestigationEvidenceError";
  }
}

export interface ProviderInvestigationResult {
  incidentId: string;
  trueForgeSessionId: string;
  turnId: string;
  providerInvestigatorThreadId: string;
  evidenceDisposition: "CAPTURED" | "REOBSERVED";
  providerStatus: string;
  providerStatusCode: number | null;
}

interface RecordValue {
  [key: string]: unknown;
}

interface ProviderInvestigatorThread {
  threadId: string;
  eventId: string;
  createdAt: string;
  parentThreadId: string;
  parentToolCallId: string;
  agentName: string;
}

interface ProviderToolCall {
  toolCallId: string;
  eventId: string;
  threadId: string;
  arguments: {
    hook_id: string;
    delivery_id: string;
  };
}

interface ObservedToolCall {
  toolCallId: string;
  eventId: string;
  threadId: string;
  functionName: string;
  argumentsText: string;
  toolInfoType: string;
  toolInfoName: string;
  toolInfoServerName: string | null;
}

interface ProviderToolResponse {
  eventId: string;
  createdAt: string;
  threadId: string;
  toolCallId: string;
  content: string;
}

interface CollectedProviderTurn {
  turnId: string;
  thread: ProviderInvestigatorThread;
  toolCall: ProviderToolCall;
  toolResponse: ProviderToolResponse;
}

interface ProviderTurnAttribution {
  turnId: string | null;
  providerInvestigatorThreadId: string | null;
  toolCallId: string | null;
  trueForgeEventId: string | null;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  record: RecordValue,
  field: string,
  description: string,
): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new ProviderInvestigationTurnError(
      `TrueForge ${description} is missing a valid ${field}.`,
    );
  }
  return value;
}

function eventType(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") {
    throw new ProviderInvestigationTurnError(
      "TrueForge emitted an event without a valid type.",
    );
  }
  return event.type;
}

function parseToolArguments(
  argumentsText: string,
  expectedHookId: string,
  expectedDeliveryId: string,
): ProviderToolCall["arguments"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText) as unknown;
  } catch {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments are not valid JSON.",
    );
  }

  if (!isRecord(parsed)) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments must be an object.",
    );
  }

  const keys = Object.keys(parsed).sort();
  if (keys.length !== 2 || keys[0] !== "delivery_id" || keys[1] !== "hook_id") {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments contain unexpected fields.",
    );
  }

  if (
    parsed.hook_id !== expectedHookId ||
    parsed.delivery_id !== expectedDeliveryId
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments do not match the deterministic incident lookup.",
    );
  }

  return {
    hook_id: expectedHookId,
    delivery_id: expectedDeliveryId,
  };
}

/**
 * TrueForge's installed runtime turns the proven remote MCP text item into the
 * tool.response content string directly. That string is one JSON document
 * containing the GitHub bridge result. No wrapper or prose representation is
 * accepted here.
 */
export function extractGithubDeliveryFromTrueForgeToolResponse(
  content: string,
): unknown {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ProviderInvestigationEvidenceError(
      "TrueForge GitHub tool.response content must be a non-empty JSON string.",
    );
  }

  let result: unknown;
  try {
    // Keep the GitHub bridge's opaque delivery ID lossless when the upstream
    // MCP text contains it as an unsafe JSON integer.
    result = parseGithubMcpToolResultJson(content);
  } catch {
    throw new ProviderInvestigationEvidenceError(
      "TrueForge GitHub tool.response content is not valid proven JSON.",
    );
  }

  if (
    !isRecord(result) ||
    !isRecord(result.full) ||
    result.full.http_status !== 200 ||
    !isRecord(result.full.body)
  ) {
    throw new ProviderInvestigationEvidenceError(
      "TrueForge GitHub tool.response does not contain the proven delivery result shape.",
    );
  }

  return result;
}

function buildProviderInvestigationInput(
  incident: {
    id: string;
    repositoryId: string;
    externalDeliveryId: string;
  },
  hookId: string,
): TrueForgeApi.TurnInputItem[] {
  const content = [
    "Run the provider-only investigation for this Redrive incident.",
    "The following values are deterministic Redrive inputs. Use them exactly; do not choose, discover, normalize, or infer replacements.",
    `incident_id=${incident.id}`,
    `repository_id=${incident.repositoryId}`,
    `hook_id=${hookId}`,
    `delivery_id=${incident.externalDeliveryId}`,
    "The provider delivery attempt ID (delivery_id) is distinct from the logical delivery GUID (X-GitHub-Delivery). The logical GUID is established only by the provider lookup result.",
    `Create exactly one dynamic subagent named ${PROVIDER_INVESTIGATOR_NAME}. Give it a self-contained provider-only task containing these exact identities.`,
    `That subagent, and only that subagent, must call ${GITHUB_WEBHOOK_DELIVERY_TOOL} on the configured GitHub MCP server with the exact hook_id and delivery_id above.`,
    "Do not call the GitHub tool from the Coordinator. Do not infer receiver state. Do not redeliver or call any write/consequential tool.",
    "If the provider lookup cannot establish a fact, report uncertainty. The machine tool.response is authoritative; agent prose is not evidence.",
  ].join("\n");

  return [{ type: "user.message", content }];
}

function requireUsableSession(
  incidentId: string,
  result: TrueForgeSessionEnsureResult,
): asserts result is TrueForgeSessionEnsureResult & {
  state: "ACTIVE";
  sessionId: string;
} {
  if (
    result.state !== "ACTIVE" ||
    result.sessionId === null ||
    (result.outcome !== "CREATED" && result.outcome !== "REUSED")
  ) {
    throw new TrueForgeSessionUnavailableError(incidentId);
  }
}

function appendFailure(
  append: (input: AppendIncidentWorkflowEventInput) => unknown,
  incidentId: string,
  sessionId: string,
  turnId: string | null,
  providerThreadId: string | null,
  toolCallId: string | null,
  trueForgeEventId: string | null,
  error: unknown,
): void {
  const reason =
    error instanceof Error ? error.name : "ProviderInvestigationFailure";
  append({
    incidentId,
    eventType: "PROVIDER_INVESTIGATION_FAILED",
    trueForgeSessionId: sessionId,
    turnId,
    providerInvestigatorThreadId: providerThreadId,
    toolCallId,
    details: {
      reason,
      ...(trueForgeEventId === null ? {} : { sourceTrueForgeEventId: trueForgeEventId }),
    },
  });
}

function appendEvidenceEvent(
  append: (input: AppendIncidentWorkflowEventInput) => unknown,
  incidentId: string,
  sessionId: string,
  turnId: string,
  thread: ProviderInvestigatorThread,
  toolCall: ProviderToolCall,
  response: ProviderToolResponse,
  capture: ProviderEvidenceCaptureResult,
): void {
  const evidence = capture.evidence;
  append({
    incidentId,
    eventType:
      capture.disposition === "CAPTURED"
        ? "PROVIDER_EVIDENCE_CAPTURED"
        : "PROVIDER_EVIDENCE_REOBSERVED",
    trueForgeSessionId: sessionId,
    turnId,
    providerInvestigatorThreadId: thread.threadId,
    trueForgeEventId: response.eventId,
    toolCallId: toolCall.toolCallId,
    occurredAt: response.createdAt,
    details: {
      providerDeliveryId: evidence.providerDeliveryId,
      deliveryGuid: evidence.deliveryGuid,
      providerStatus: evidence.outcome.status,
      providerStatusCode: evidence.outcome.statusCode,
      captureDisposition: capture.disposition,
      toolCallEventId: toolCall.eventId,
      providerThreadEventId: thread.eventId,
    },
  });
}

function appendConflictEvent(
  append: (input: AppendIncidentWorkflowEventInput) => unknown,
  incidentId: string,
  sessionId: string,
  turnId: string,
  thread: ProviderInvestigatorThread,
  toolCall: ProviderToolCall,
  response: ProviderToolResponse,
  conflict: ProviderEvidenceConflictError,
): void {
  append({
    incidentId,
    eventType: "PROVIDER_OBSERVATION_CONFLICT",
    trueForgeSessionId: sessionId,
    turnId,
    providerInvestigatorThreadId: thread.threadId,
    trueForgeEventId: response.eventId,
    toolCallId: toolCall.toolCallId,
    occurredAt: response.createdAt,
    details: {
      existingDeliveryGuid: conflict.existing.deliveryGuid,
      observedDeliveryGuid: conflict.observation.deliveryGuid,
      existingProviderStatus: conflict.existing.outcome.status,
      observedProviderStatus: conflict.observation.outcome.status,
      existingPayloadSha256:
        conflict.existing.request.canonicalPayloadSha256,
      observedPayloadSha256:
        conflict.observation.request.canonicalPayloadSha256,
    },
  });
}

async function collectTurnLifecycle(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  onAttribution?: (attribution: ProviderTurnAttribution) => void,
): Promise<string> {
  let turnId: string | null = null;
  let turnCreated = false;
  let turnDone = false;

  for await (const event of stream) {
    if (turnDone) {
      throw new ProviderInvestigationTurnError(
        "TrueForge emitted an event after turn.done.",
      );
    }
    const type = eventType(event);
    if (!isRecord(event)) {
      throw new ProviderInvestigationTurnError(
        "TrueForge emitted an invalid event.",
      );
    }
    const eventId = typeof event.id === "string" ? event.id : null;

    if (type === "turn.created") {
      if (turnCreated) {
        throw new ProviderInvestigationTurnError(
          "TrueForge emitted more than one turn.created event for the turn.",
        );
      }
      turnId = requiredString(event, "turnId", "turn.created event");
      if (!isRecord(event.state) || event.state.status !== "running") {
        throw new ProviderInvestigationTurnError(
          "TrueForge turn.created did not contain a running state.",
        );
      }
      turnCreated = true;
      onAttribution?.({
        turnId,
        providerInvestigatorThreadId: null,
        toolCallId: null,
        trueForgeEventId: eventId,
      });
      continue;
    }

    if (type === "turn.done") {
      if (turnDone) {
        throw new ProviderInvestigationTurnError(
          "TrueForge emitted more than one turn.done event for the turn.",
        );
      }
      if (!isRecord(event.state) || event.state.status !== "done") {
        throw new ProviderInvestigationTurnError(
          "TrueForge provider investigation turn did not finish normally.",
        );
      }
      turnDone = true;
    }
  }

  if (!turnCreated || turnId === null) {
    throw new ProviderInvestigationTurnError(
      "TrueForge provider investigation stream did not identify its turn.",
    );
  }
  if (!turnDone) {
    throw new ProviderInvestigationTurnError(
      "TrueForge provider investigation stream ended without turn.done.",
    );
  }
  return turnId;
}

interface PersistedTurnEvent {
  event: RecordValue;
  sourceIndex: number;
}

function persistedEventRank(event: RecordValue): number {
  switch (event.type) {
    case "turn.created":
      return 0;
    case "thread.created":
      return 1;
    case "model.message":
      return 2;
    case "tool.response":
      return 3;
    case "turn.done":
      return 4;
    default:
      return 5;
  }
}

async function* collectPersistedTurnEvents(
  items: AsyncIterable<TrueForgeApi.SessionEventItem>,
  completedTurnId: string,
): AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
  const events: PersistedTurnEvent[] = [];
  let sourceIndex = 0;

  for await (const item of items) {
    if (!isRecord(item)) {
      throw new ProviderInvestigationTurnError(
        "TrueForge persisted session events contained an invalid item.",
      );
    }
    const itemTurnId = requiredString(
      item,
      "turnId",
      "persisted session event item",
    );
    if (!isRecord(item.event)) {
      throw new ProviderInvestigationTurnError(
        "TrueForge persisted session event item contained an invalid event.",
      );
    }
    const event = item.event;
    if (eventType(event) === "turn.created") {
      const eventTurnId = requiredString(
        event,
        "turnId",
        "persisted turn.created event",
      );
      if (eventTurnId !== itemTurnId) {
        throw new ProviderInvestigationTurnError(
          "TrueForge persisted turn.created attribution does not match its turn.",
        );
      }
    }
    if (itemTurnId === completedTurnId) {
      events.push({ event, sourceIndex });
    }
    sourceIndex += 1;
  }

  if (events.length === 0) {
    throw new ProviderInvestigationTurnError(
      "TrueForge persisted session events did not contain the completed turn.",
    );
  }

  const allHaveCreatedAt = events.every(
    ({ event }) => typeof event.createdAt === "string" && event.createdAt.length > 0,
  );
  events.sort((left, right) => {
    if (allHaveCreatedAt) {
      const leftCreatedAt = left.event.createdAt as string;
      const rightCreatedAt = right.event.createdAt as string;
      const byTime =
        leftCreatedAt < rightCreatedAt
          ? -1
          : leftCreatedAt > rightCreatedAt
            ? 1
            : 0;
      if (byTime !== 0) return byTime;
    } else {
      const byRank =
        persistedEventRank(left.event) - persistedEventRank(right.event);
      if (byRank !== 0) return byRank;
    }
    return left.sourceIndex - right.sourceIndex;
  });

  for (const { event } of events) {
    yield event as unknown as TrueForgeApi.TurnStreamingEvent;
  }
}

async function collectProviderTurn(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  expectedHookId: string,
  expectedDeliveryId: string,
  expectedMcpServerName: string,
  onAttribution?: (attribution: ProviderTurnAttribution) => void,
): Promise<CollectedProviderTurn> {
  let turnId: string | null = null;
  let turnCreated = false;
  let turnDone = false;
  const threads: ProviderInvestigatorThread[] = [];
  const observedToolCalls: ObservedToolCall[] = [];
  const toolResponses: ProviderToolResponse[] = [];
  let providerThreadId: string | null = null;
  let providerToolCallId: string | null = null;

  for await (const event of stream) {
    const type = eventType(event);
    if (turnDone) {
      throw new ProviderInvestigationTurnError(
        "TrueForge emitted an event after turn.done.",
      );
    }
    const eventId =
      isRecord(event) && typeof event.id === "string" ? event.id : null;
    onAttribution?.({
      turnId,
      providerInvestigatorThreadId: providerThreadId,
      toolCallId: providerToolCallId,
      trueForgeEventId: eventId,
    });
    if (!isRecord(event)) {
      throw new ProviderInvestigationTurnError(
        "TrueForge emitted an invalid event.",
      );
    }

    if (type === "turn.created") {
      if (turnCreated) {
        throw new ProviderInvestigationTurnError(
          "TrueForge emitted more than one turn.created event for the turn.",
        );
      }
      turnId = requiredString(event, "turnId", "turn.created event");
      const eventState = event.state;
      if (!isRecord(eventState) || eventState.status !== "running") {
        throw new ProviderInvestigationTurnError(
          "TrueForge turn.created did not contain a running state.",
        );
      }
      turnCreated = true;
      onAttribution?.({
        turnId,
        providerInvestigatorThreadId: providerThreadId,
        toolCallId: providerToolCallId,
        trueForgeEventId: eventId,
      });
      continue;
    }

    if (type === "thread.created") {
      const agentInfo = event.agentInfo;
      const parent = event.parent;
      if (!isRecord(agentInfo) || !isRecord(parent)) {
        throw new ProviderInvestigationTurnError(
          "TrueForge thread.created did not contain its dynamic-agent attribution.",
        );
      }
      if (
        agentInfo.type !== "dynamic" ||
        typeof agentInfo.name !== "string" ||
        agentInfo.name.length === 0 ||
        typeof agentInfo.input !== "string" ||
        agentInfo.input.length === 0
      ) {
        throw new ProviderInvestigationTurnError(
          "TrueForge thread.created did not identify a dynamic subagent.",
        );
      }
      const thread = {
        threadId: requiredString(event, "threadId", "thread.created event"),
        eventId: requiredString(event, "id", "thread.created event"),
        createdAt: requiredString(event, "createdAt", "thread.created event"),
        parentThreadId: requiredString(
          parent,
          "threadId",
          "thread.created parent",
        ),
        parentToolCallId: requiredString(
          parent,
          "toolCallId",
          "thread.created parent",
        ),
        agentName: agentInfo.name,
      } satisfies ProviderInvestigatorThread;
      threads.push(thread);
      if (thread.agentName === PROVIDER_INVESTIGATOR_NAME) {
        providerThreadId = thread.threadId;
        onAttribution?.({
          turnId,
          providerInvestigatorThreadId: providerThreadId,
          toolCallId: providerToolCallId,
          trueForgeEventId: thread.eventId,
        });
      }
      continue;
    }

    if (type === "model.message") {
      const threadId = requiredString(event, "threadId", "model.message event");
      if (
        Object.prototype.hasOwnProperty.call(event, "toolCalls") &&
        !Array.isArray(event.toolCalls)
      ) {
        throw new ProviderInvestigationTurnError(
          "TrueForge model.message contained an invalid tool call list.",
        );
      }
      if (!Array.isArray(event.toolCalls)) {
        continue;
      }

      const modelMessageId = requiredString(
        event,
        "id",
        "model.message event",
      );
      for (const rawToolCall of event.toolCalls) {
        if (!isRecord(rawToolCall)) {
          throw new ProviderInvestigationTurnError(
            "TrueForge model.message contained an invalid tool call.",
          );
        }
        const functionValue = rawToolCall.function;
        const toolInfo = rawToolCall.toolInfo;
        if (
          rawToolCall.type !== "function" ||
          typeof rawToolCall.id !== "string" ||
          rawToolCall.id.length === 0 ||
          !isRecord(functionValue) ||
          typeof functionValue.name !== "string" ||
          typeof functionValue.arguments !== "string" ||
          !isRecord(toolInfo) ||
          typeof toolInfo.type !== "string" ||
          typeof toolInfo.name !== "string"
        ) {
          throw new ProviderInvestigationTurnError(
            "TrueForge model.message contained an invalid tool call shape.",
          );
        }

        const observedToolCall = {
          toolCallId: rawToolCall.id,
          eventId: modelMessageId,
          threadId,
          functionName: functionValue.name,
          argumentsText: functionValue.arguments,
          toolInfoType: toolInfo.type,
          toolInfoName: toolInfo.name,
          toolInfoServerName:
            typeof toolInfo.serverName === "string"
              ? toolInfo.serverName
              : null,
        } satisfies ObservedToolCall;
        observedToolCalls.push(observedToolCall);
        if (threadId === providerThreadId) {
          providerToolCallId = observedToolCall.toolCallId;
          onAttribution?.({
            turnId,
            providerInvestigatorThreadId: providerThreadId,
            toolCallId: providerToolCallId,
            trueForgeEventId: modelMessageId,
          });
        }
      }
      continue;
    }

    if (type === "tool.response") {
      const content = event.content;

      if (typeof content !== "string") {
        throw new ProviderInvestigationTurnError(
          "TrueForge tool.response event contained invalid content.",
        );
      }
      const toolResponse = {
        eventId: requiredString(event, "id", "tool.response event"),
        createdAt: requiredString(event, "createdAt", "tool.response event"),
        threadId: requiredString(event, "threadId", "tool.response event"),
        toolCallId: requiredString(
          event,
          "toolCallId",
          "tool.response event",
        ),
        content,
      } satisfies ProviderToolResponse;
      toolResponses.push(toolResponse);
      if (toolResponse.threadId === providerThreadId) {
        onAttribution?.({
          turnId,
          providerInvestigatorThreadId: providerThreadId,
          toolCallId: providerToolCallId,
          trueForgeEventId: toolResponse.eventId,
        });
      }
      continue;
    }

    if (type === "turn.done") {
      if (turnDone) {
        throw new ProviderInvestigationTurnError(
          "TrueForge emitted more than one turn.done event for the turn.",
        );
      }
      if (!isRecord(event.state) || event.state.status !== "done") {
        throw new ProviderInvestigationTurnError(
          "TrueForge provider investigation turn did not finish normally.",
        );
      }
      turnDone = true;
    }
  }

  if (!turnCreated || turnId === null) {
    throw new ProviderInvestigationTurnError(
      "TrueForge provider investigation stream did not identify its turn.",
    );
  }
  if (!turnDone) {
    throw new ProviderInvestigationTurnError(
      "TrueForge provider investigation stream ended without turn.done.",
    );
  }

  if (
    threads.length !== 1 ||
    threads[0].agentName !== PROVIDER_INVESTIGATOR_NAME
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge did not create exactly one dynamic provider-investigator thread.",
    );
  }
  const thread = threads[0];

  // Dynamic subagents are created by the root thread through TrueForge's
  // built-in create_sub_agent tool. It is the one allowed non-provider call;
  // correlate it to thread.created so a root GitHub lookup never qualifies.
  const parentToolCalls = observedToolCalls.filter(
    (toolCall) => toolCall.threadId !== thread.threadId,
  );
  if (
    parentToolCalls.length !== 1 ||
    parentToolCalls[0].threadId !== thread.parentThreadId ||
    parentToolCalls[0].toolCallId !== thread.parentToolCallId ||
    parentToolCalls[0].toolInfoType !== "truefoundry-system" ||
    parentToolCalls[0].toolInfoName !== CREATE_SUB_AGENT_TOOL ||
    parentToolCalls[0].functionName !== CREATE_SUB_AGENT_TOOL
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge did not attribute provider-investigator creation to its expected dynamic-subagent call.",
    );
  }

  const providerToolCalls = observedToolCalls.filter(
    (toolCall) => toolCall.threadId === thread.threadId,
  );
  if (providerToolCalls.length !== 1) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not make exactly one GitHub MCP call.",
    );
  }
  const observedToolCall = providerToolCalls[0];
  if (
    observedToolCall.toolInfoType !== "mcp" ||
    observedToolCall.toolInfoServerName !== expectedMcpServerName ||
    observedToolCall.toolInfoName !== GITHUB_WEBHOOK_DELIVERY_TOOL ||
    observedToolCall.functionName !== GITHUB_WEBHOOK_DELIVERY_TOOL
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not call the configured read-only GitHub MCP tool.",
    );
  }

  const toolCall: ProviderToolCall = {
    toolCallId: observedToolCall.toolCallId,
    eventId: observedToolCall.eventId,
    threadId: observedToolCall.threadId,
    arguments: parseToolArguments(
      observedToolCall.argumentsText,
      expectedHookId,
      expectedDeliveryId,
    ),
  };

  const matchingResponses = toolResponses.filter(
    (response) =>
      response.threadId === thread.threadId &&
      response.toolCallId === toolCall.toolCallId,
  );
  if (matchingResponses.length !== 1) {
    throw new ProviderInvestigationTurnError(
      "TrueForge did not emit exactly one matching Provider Investigator tool.response.",
    );
  }

  return {
    turnId,
    thread,
    toolCall,
    toolResponse: matchingResponses[0],
  };
}

export function createProviderInvestigationService(
  database: SqliteDatabase,
  trueForgeClient: TrueForgeIncidentClient,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
) {
  const incidentService = createIncidentService(database);
  const sessionService = createTrueForgeSessionService(
    database,
    trueForgeClient,
    now,
    environment,
  );
  const evidenceService = createProviderEvidenceService(database, null, now);
  const workflowEvents = createIncidentWorkflowEventService(database, now);

  async function investigate(
    incidentId: string,
  ): Promise<ProviderInvestigationResult> {
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new IncidentNotFoundError(incidentId);
    }
    if (incident.provider !== GITHUB_PROVIDER) {
      throw new UnsupportedProviderEvidenceError(incident.provider);
    }

    // Validate every deterministic execution input before any remote session
    // creation, inline update, or turn can occur.
    getRecoveryCoordinatorAgentSpec(environment);

    const configuredMcpName = environment.REDRIVE_TRUEFORGE_GITHUB_MCP_NAME?.trim();
    if (!configuredMcpName) {
      throw new ProviderInvestigationConfigurationError(
        "REDRIVE_TRUEFORGE_GITHUB_MCP_NAME must be configured.",
      );
    }

    let hookId: string;
    try {
      hookId = resolveConfiguredGithubHookId(incident.repositoryId, environment);
    } catch (error) {
      if (error instanceof GithubMcpConfigurationError) {
        throw error;
      }
      throw new ProviderInvestigationConfigurationError(
        "GitHub webhook hook mapping could not be resolved.",
        { cause: error },
      );
    }

    const ensured = await sessionService.ensureTrueForgeSession(incidentId);
    const upgraded = await sessionService.ensureCoordinatorV2(
      incidentId,
      ensured,
    );
    requireUsableSession(incidentId, upgraded);

    workflowEvents.append({
      incidentId,
      eventType: "PROVIDER_INVESTIGATION_STARTED",
      trueForgeSessionId: upgraded.sessionId,
      occurredAt: now(),
      details: {
        repositoryId: incident.repositoryId,
        hookId,
        providerDeliveryId: incident.externalDeliveryId,
        mcpServerName: configuredMcpName,
        skillName: PROVIDER_INVESTIGATION_SKILL_NAME,
      },
    });

    let turnId: string | null = null;
    let providerThreadId: string | null = null;
    let toolCallId: string | null = null;
    let trueForgeEventId: string | null = null;

    try {
      const stream = await trueForgeClient.createTurnStream(
        upgraded.sessionId,
        {
          input: buildProviderInvestigationInput(incident, hookId),
        },
      );
      let collected: CollectedProviderTurn;
      try {
        // The live stream is only a turn-creation/terminal-status channel.
        // Dynamic child events are read from the persisted session event log
        // after the server reports the turn completed.
        const completedTurnId = await collectTurnLifecycle(
          stream,
          (attribution) => {
            turnId = attribution.turnId ?? turnId;
            trueForgeEventId =
              attribution.trueForgeEventId ?? trueForgeEventId;
          },
        );
        const persistedEvents = await trueForgeClient.listEvents(
          upgraded.sessionId,
        );
        collected = await collectProviderTurn(
          collectPersistedTurnEvents(persistedEvents, completedTurnId),
          hookId,
          incident.externalDeliveryId,
          configuredMcpName,
          (attribution) => {
            turnId = attribution.turnId ?? turnId;
            providerThreadId =
              attribution.providerInvestigatorThreadId ?? providerThreadId;
            toolCallId = attribution.toolCallId ?? toolCallId;
            trueForgeEventId =
              attribution.trueForgeEventId ?? trueForgeEventId;
          },
        );
      } catch (error) {
        if (error instanceof ProviderInvestigationTurnError) {
          throw error;
        }
        throw new ProviderInvestigationTurnError(
          "TrueForge provider investigation events could not be collected.",
          { cause: error },
        );
      }
      turnId = collected.turnId;
      providerThreadId = collected.thread.threadId;
      toolCallId = collected.toolCall.toolCallId;
      trueForgeEventId = collected.toolResponse.eventId;

      workflowEvents.append({
        incidentId,
        eventType: "PROVIDER_INVESTIGATOR_STARTED",
        trueForgeSessionId: upgraded.sessionId,
        turnId,
        providerInvestigatorThreadId: providerThreadId,
        trueForgeEventId: collected.thread.eventId,
        toolCallId: collected.thread.parentToolCallId,
        occurredAt: collected.thread.createdAt,
        details: {
          agentName: PROVIDER_INVESTIGATOR_NAME,
          parentThreadId: collected.thread.parentThreadId,
          parentToolCallId: collected.thread.parentToolCallId,
        },
      });

      const githubResult = extractGithubDeliveryFromTrueForgeToolResponse(
        collected.toolResponse.content,
      );
      let capture: ProviderEvidenceCaptureResult;
      try {
        capture = evidenceService.captureOrReconcileForIncident(
          incidentId,
          githubResult,
        );
      } catch (error) {
        if (error instanceof ProviderEvidenceConflictError) {
          appendConflictEvent(
            workflowEvents.append,
            incidentId,
            upgraded.sessionId,
            turnId,
            collected.thread,
            collected.toolCall,
            collected.toolResponse,
            error,
          );
        }
        throw error;
      }

      appendEvidenceEvent(
        workflowEvents.append,
        incidentId,
        upgraded.sessionId,
        turnId,
        collected.thread,
        collected.toolCall,
        collected.toolResponse,
        capture,
      );

      return {
        incidentId,
        trueForgeSessionId: upgraded.sessionId,
        turnId,
        providerInvestigatorThreadId: providerThreadId,
        evidenceDisposition: capture.disposition,
        providerStatus: capture.evidence.outcome.status,
        providerStatusCode: capture.evidence.outcome.statusCode,
      };
    } catch (error) {
      appendFailure(
        workflowEvents.append,
        incidentId,
        upgraded.sessionId,
        turnId,
        providerThreadId,
        toolCallId,
        trueForgeEventId,
        error,
      );
      if (error instanceof ProviderInvestigationTurnError) {
        throw error;
      }
      if (error instanceof ProviderInvestigationEvidenceError) {
        throw error;
      }
      throw error;
    }
  }

  return {
    investigateProviderForIncident: investigate,
    getWorkflowEvents: workflowEvents.listByIncidentId,
  };
}

type ProviderInvestigationService = ReturnType<
  typeof createProviderInvestigationService
>;

function withConfiguredService<T>(
  operation: (service: ProviderInvestigationService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(
    createProviderInvestigationService(
      database,
      createConfiguredTrueForgeClient(),
    ),
  );
}

export async function investigateProviderForIncident(
  incidentId: string,
): Promise<ProviderInvestigationResult> {
  return withConfiguredService((service) =>
    service.investigateProviderForIncident(incidentId),
  );
}
