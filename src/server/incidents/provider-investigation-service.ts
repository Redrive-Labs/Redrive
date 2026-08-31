import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  GITHUB_PROVIDER,
  type ProviderEvidence,
} from "@/domain/provider-evidence";
import {
  CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME,
  CONNECTION_TRUEFORGE_GITHUB_MCP_ENV,
  GITHUB_WEBHOOK_DELIVERY_TOOL,
  getConnectionRecoveryCoordinatorAgentSpec,
} from "@/agents/recovery-coordinator";
import { parseGithubMcpToolResultJson } from "@/server/github/github-mcp";
import { createIncidentService } from "@/server/incidents/incident-service";
import {
  createIncidentWorkflowEventService,
  type AppendIncidentWorkflowEventInput,
} from "@/server/incidents/incident-workflow-event-service";
import type { IncidentWorkflowEventDetails } from "@/domain/incident-workflow-event";
import {
  createProviderEvidenceService,
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
  UnsupportedProviderEvidenceError,
  type ProviderEvidenceCaptureResult,
} from "@/server/incidents/provider-evidence-service";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { getServerConfig } from "@/server/infrastructure/config";
import {
  createConfiguredTrueForgeClient,
  TrueForgeTurnInProgressError,
  type TrueForgeIncidentClient,
} from "@/server/trueforge/trueforge-client";
import {
  createTrueForgeSessionService,
  TrueForgeSessionUnavailableError,
  type TrueForgeSessionEnsureResult,
} from "@/server/trueforge/trueforge-session-service";

export const PROVIDER_INVESTIGATOR_NAME = "provider-investigator" as const;
const CREATE_SUB_AGENT_TOOL = "create_sub_agent" as const;
const EXEC_TOOL = "exec" as const;
const READ_FILE_TOOL = "read_file" as const;
const GET_TOOL_OUTPUT_SCHEMA_TOOL = "get_tool_output_schema" as const;
const MAX_SKILL_BOOTSTRAP_CALLS = 8;
const MAX_SCHEMA_INTROSPECTION_CALLS = 1;
const ALLOWED_REDRIVE_SKILL_PATHS = [
  "/opt/tf/skills/redrive-connection-provider-investigation/SKILL.md",
  "/opt/tf/skills/redrive-connection-receiver-investigation/SKILL.md",
] as const;

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

class ProviderInvestigationUnexpectedArgumentsError extends ProviderInvestigationTurnError {
  readonly additionalKeys: string[];

  constructor(additionalKeys: string[]) {
    super("Provider Investigator MCP tool arguments contain unexpected fields.");
    this.name = "ProviderInvestigationUnexpectedArgumentsError";
    this.additionalKeys = additionalKeys;
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

type ProviderToolArguments = {
  connection_id: string;
  delivery_id: string;
};

interface ProviderToolCall {
  toolCallId: string;
  eventId: string;
  threadId: string;
  arguments: ProviderToolArguments;
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

type ProviderToolCategory =
  | "create_sub_agent"
  | "skill_bootstrap"
  | "schema_introspection"
  | "evidence"
  | "forbidden";

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
  expectedConnectionId: string,
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

  const connectionArgument = parsed.connection_id;
  const deliveryArgument = parsed.delivery_id;
  if (
    typeof connectionArgument !== "string" ||
    connectionArgument.length === 0
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments are missing a valid connection_id.",
    );
  }
  if (
    typeof deliveryArgument !== "string" ||
    deliveryArgument.length === 0
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments are missing a valid delivery_id.",
    );
  }

  if (
    connectionArgument !== expectedConnectionId ||
    deliveryArgument !== expectedDeliveryId
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator MCP tool arguments do not match the deterministic incident lookup.",
    );
  }

  const additionalKeys = Object.keys(parsed)
    .filter((key) => key !== "connection_id" && key !== "delivery_id")
    .sort();
  if (additionalKeys.length > 0) {
    throw new ProviderInvestigationUnexpectedArgumentsError(additionalKeys);
  }

  return {
    connection_id: expectedConnectionId,
    delivery_id: expectedDeliveryId,
  };
}

function parseTrueForgeProviderToolArguments(
  argumentsText: string,
  expectedConnectionId: string,
  expectedDeliveryId: string,
  expectedMcpServerName: string,
): ProviderToolArguments {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText) as unknown;
  } catch {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper arguments are not valid JSON.",
    );
  }

  if (!isRecord(parsed)) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper arguments must be an object.",
    );
  }

  const expectedKeys = ["mcp_server", "tool_name", "input"] as const;
  const additionalKeys = Object.keys(parsed)
    .filter((key) => !expectedKeys.includes(key as (typeof expectedKeys)[number]))
    .sort();
  if (additionalKeys.length > 0) {
    throw new ProviderInvestigationUnexpectedArgumentsError(additionalKeys);
  }
  if (
    expectedKeys.some(
      (key) => !Object.prototype.hasOwnProperty.call(parsed, key),
    )
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper arguments are missing required fields.",
    );
  }

  if (
    parsed.mcp_server !== expectedMcpServerName ||
    parsed.tool_name !== GITHUB_WEBHOOK_DELIVERY_TOOL
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper did not identify the configured GitHub MCP tool.",
    );
  }
  if (!isRecord(parsed.input)) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper input must be an object.",
    );
  }

  const inputArguments = JSON.stringify(parsed.input);
  if (typeof inputArguments !== "string") {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator TrueForge MCP wrapper input could not be normalized.",
    );
  }
  return parseToolArguments(
    inputArguments,
    expectedConnectionId,
    expectedDeliveryId,
  );
}

function allowedSkillPath(value: unknown): string | null {
  return typeof value === "string" &&
    (ALLOWED_REDRIVE_SKILL_PATHS as readonly string[]).includes(value)
    ? value
    : null;
}

function parseSkillBootstrapPath(toolCall: ObservedToolCall): string | null {
  if (
    toolCall.toolInfoType === "truefoundry-system" &&
    toolCall.toolInfoName === EXEC_TOOL &&
    toolCall.functionName === EXEC_TOOL
  ) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toolCall.argumentsText) as unknown;
    } catch {
      return null;
    }
    if (!isRecord(parsed)) return null;
    const keys = Object.keys(parsed);
    if (
      !Object.prototype.hasOwnProperty.call(parsed, "command") ||
      keys.some((key) => key !== "command" && key !== "intent") ||
      (Object.prototype.hasOwnProperty.call(parsed, "intent") &&
        typeof parsed.intent !== "string") ||
      typeof parsed.command !== "string"
    ) {
      return null;
    }
    for (const path of ALLOWED_REDRIVE_SKILL_PATHS) {
      if (parsed.command === `cat ${path}`) return path;
    }
    return null;
  }

  if (
    toolCall.functionName !== READ_FILE_TOOL ||
    toolCall.toolInfoName !== READ_FILE_TOOL
  ) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.argumentsText) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed === "string") return allowedSkillPath(parsed);
  if (!isRecord(parsed) || Object.keys(parsed).length !== 1) return null;
  return allowedSkillPath(parsed.path);
}

function classifyProviderToolCall(
  toolCall: ObservedToolCall,
  expectedMcpServerName: string,
): ProviderToolCategory {
  if (
    toolCall.toolInfoType === "truefoundry-system" &&
    toolCall.toolInfoName === CREATE_SUB_AGENT_TOOL &&
    toolCall.functionName === CREATE_SUB_AGENT_TOOL
  ) {
    return "create_sub_agent";
  }
  if (parseSkillBootstrapPath(toolCall) !== null) return "skill_bootstrap";
  if (
    toolCall.toolInfoType === "truefoundry-system" &&
    toolCall.toolInfoName === GET_TOOL_OUTPUT_SCHEMA_TOOL &&
    toolCall.functionName === GET_TOOL_OUTPUT_SCHEMA_TOOL
  ) {
    return "schema_introspection";
  }
  if (
    (toolCall.toolInfoType === "mcp" &&
      toolCall.toolInfoServerName === expectedMcpServerName &&
      toolCall.toolInfoName === GITHUB_WEBHOOK_DELIVERY_TOOL &&
      toolCall.functionName === GITHUB_WEBHOOK_DELIVERY_TOOL) ||
    (toolCall.toolInfoType === "truefoundry-system" &&
      toolCall.toolInfoName === "call_tool" &&
      toolCall.functionName === "call_tool")
  ) {
    return "evidence";
  }
  return "forbidden";
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
  connectionId: string,
  deliveryId: string,
  corrective = false,
): TrueForgeApi.TurnInputItem[] {
  const content = [
    corrective
      ? "The previous provider investigation attempt was rejected because it added extra argument keys."
      : "Run the connection-backed provider-only investigation.",
    "Use the following exact provider lookup tuple. Do not choose, discover, normalize, or infer replacements.",
    `connection_id=${connectionId}`,
    `delivery_id=${deliveryId}`,
    corrective
      ? `The JSON argument object for ${GITHUB_WEBHOOK_DELIVERY_TOOL} must contain EXACTLY: {"connection_id":"${connectionId}","delivery_id":"${deliveryId}"} and no other properties.`
      : `Create exactly one dynamic subagent named ${PROVIDER_INVESTIGATOR_NAME}. Give it a self-contained provider-only task containing only this exact tuple.`,
    corrective
      ? `Create exactly one fresh dynamic subagent named ${PROVIDER_INVESTIGATOR_NAME}. Give it a self-contained provider-only task containing only this exact tuple. It, and only it, must call ${GITHUB_WEBHOOK_DELIVERY_TOOL} on the configured GitHub MCP server with exactly connection_id and delivery_id.`
      : `That subagent, and only that subagent, must call ${GITHUB_WEBHOOK_DELIVERY_TOOL} on the configured GitHub MCP server with exactly connection_id and delivery_id.`,
    "Do not infer receiver state. Do not redeliver or call any write or consequential tool.",
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
  additionalDetails?: IncidentWorkflowEventDetails,
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
      ...additionalDetails,
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

async function collectProviderTurn(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  expectedTurnId: string,
  expectedConnectionId: string,
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
  const toolCallIds = new Set<string>();
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
      const persistedTurnId = requiredString(event, "turnId", "turn.created event");
      if (persistedTurnId !== expectedTurnId) {
        throw new ProviderInvestigationTurnError(
          "TrueForge persisted provider investigation events do not match the completed live turn.",
        );
      }
      turnId = persistedTurnId;
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
        if (toolCallIds.has(rawToolCall.id)) {
          throw new ProviderInvestigationTurnError(
            "TrueForge provider tool-call IDs are not unique within the completed turn.",
          );
        }
        toolCallIds.add(rawToolCall.id);

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

  const classifiedToolCalls = observedToolCalls.map((toolCall) => ({
    toolCall,
    category: classifyProviderToolCall(toolCall, expectedMcpServerName),
  }));
  const parentToolCalls = classifiedToolCalls.filter(
    ({ toolCall }) => toolCall.threadId !== thread.threadId,
  );
  if (parentToolCalls.some(({ toolCall }) => toolCall.threadId !== thread.parentThreadId)) {
    throw new ProviderInvestigationTurnError(
      "TrueForge emitted a provider tool call outside the root or expected child thread.",
    );
  }
  const rootCreateToolCalls = parentToolCalls.filter(
    ({ category }) => category === "create_sub_agent",
  );
  if (
    rootCreateToolCalls.length !== 1 ||
    rootCreateToolCalls[0].toolCall.toolCallId !== thread.parentToolCallId
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge did not attribute provider-investigator creation to its expected dynamic-subagent call.",
    );
  }

  if (
    parentToolCalls.some(
      ({ category }) =>
        category !== "create_sub_agent" && category !== "skill_bootstrap",
    )
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge root provider calls may only create the investigator or read an attached Redrive skill.",
    );
  }

  const childToolCalls = classifiedToolCalls.filter(
    ({ toolCall }) => toolCall.threadId === thread.threadId,
  );
  if (
    childToolCalls.some(
      ({ category }) =>
        category === "forbidden" || category === "create_sub_agent",
    )
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator emitted a forbidden tool call.",
    );
  }
  const bootstrapToolCalls = classifiedToolCalls.filter(
    ({ category }) => category === "skill_bootstrap",
  );
  if (bootstrapToolCalls.length > MAX_SKILL_BOOTSTRAP_CALLS) {
    throw new ProviderInvestigationTurnError(
      "TrueForge emitted more than the allowed number of skill-bootstrap reads.",
    );
  }
  const schemaIntrospectionToolCalls = childToolCalls.filter(
    ({ category }) => category === "schema_introspection",
  );
  if (schemaIntrospectionToolCalls.length > MAX_SCHEMA_INTROSPECTION_CALLS) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator emitted more than the allowed number of read-only schema-introspection calls.",
    );
  }

  const providerToolCalls = childToolCalls.filter(
    ({ category }) => category === "evidence",
  );
  if (providerToolCalls.length !== 1) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not make exactly one GitHub MCP call.",
    );
  }
  const observedToolCall = providerToolCalls[0].toolCall;
  const isDirectMcpCall = observedToolCall.toolInfoType === "mcp";
  const isTrueForgeWrapperCall =
    observedToolCall.toolInfoType === "truefoundry-system";
  if (!isDirectMcpCall && !isTrueForgeWrapperCall) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not call the configured read-only GitHub MCP tool.",
    );
  }
  if (
    isDirectMcpCall &&
    (observedToolCall.toolInfoServerName !== expectedMcpServerName ||
      observedToolCall.toolInfoName !== GITHUB_WEBHOOK_DELIVERY_TOOL ||
      observedToolCall.functionName !== GITHUB_WEBHOOK_DELIVERY_TOOL)
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not call the configured read-only GitHub MCP tool.",
    );
  }
  if (
    isTrueForgeWrapperCall &&
    (observedToolCall.toolInfoName !== "call_tool" ||
      observedToolCall.functionName !== "call_tool")
  ) {
    throw new ProviderInvestigationTurnError(
      "Provider Investigator did not call the configured GitHub MCP tool through the TrueForge system wrapper.",
    );
  }

  const responsesFor = (toolCall: ObservedToolCall) =>
    toolResponses.filter(
      (response) =>
        response.threadId === toolCall.threadId &&
        response.toolCallId === toolCall.toolCallId,
    );
  const observedToolCallSet = new Set(
    observedToolCalls.map(
      (toolCall) => `${toolCall.threadId}\u0000${toolCall.toolCallId}`,
    ),
  );
  if (
    toolResponses.some(
      (response) =>
        !observedToolCallSet.has(
          `${response.threadId}\u0000${response.toolCallId}`,
        ),
    )
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge emitted a tool.response without a correlated provider tool call.",
    );
  }

  for (const bootstrap of bootstrapToolCalls) {
    if (responsesFor(bootstrap.toolCall).length !== 1) {
      throw new ProviderInvestigationTurnError(
        "TrueForge did not emit exactly one response for a skill-bootstrap read.",
      );
    }
  }
  for (const introspection of schemaIntrospectionToolCalls) {
    if (responsesFor(introspection.toolCall).length !== 1) {
      throw new ProviderInvestigationTurnError(
        "TrueForge did not emit exactly one response for a schema-introspection call.",
      );
    }
  }

  const createResponses = responsesFor(rootCreateToolCalls[0].toolCall);
  if (
    createResponses.length > 1 ||
    (createResponses.length === 1 && createResponses[0].content !== "")
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge emitted an invalid create_sub_agent tool.response.",
    );
  }

  const matchingResponses = responsesFor(observedToolCall);
  if (
    matchingResponses.length !== 1 ||
    matchingResponses[0].content.trim().length === 0
  ) {
    throw new ProviderInvestigationTurnError(
      "TrueForge did not emit exactly one matching Provider Investigator tool.response.",
    );
  }

  let argumentsValue: ProviderToolArguments;
  try {
    argumentsValue = isDirectMcpCall
      ? parseToolArguments(
          observedToolCall.argumentsText,
          expectedConnectionId,
          expectedDeliveryId,
        )
      : parseTrueForgeProviderToolArguments(
          observedToolCall.argumentsText,
          expectedConnectionId,
          expectedDeliveryId,
          expectedMcpServerName,
        );
  } catch (error) {
    if (error instanceof ProviderInvestigationUnexpectedArgumentsError) {
      // Keep the failed attempt attributable to the model tool-call event,
      // rather than the later turn terminal event.
      onAttribution?.({
        turnId,
        providerInvestigatorThreadId: thread.threadId,
        toolCallId: observedToolCall.toolCallId,
        trueForgeEventId: observedToolCall.eventId,
      });
    }
    throw error;
  }

  const toolCall: ProviderToolCall = {
    toolCallId: observedToolCall.toolCallId,
    eventId: observedToolCall.eventId,
    threadId: observedToolCall.threadId,
    arguments: argumentsValue,
  };

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
  const evidenceService = createProviderEvidenceService(database, now);
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
    const connectionId = incident.applicationConnectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new UnsupportedProviderEvidenceError(
        "legacy provider investigation",
      );
    }

    const configuredMcpName = environment[CONNECTION_TRUEFORGE_GITHUB_MCP_ENV]?.trim();
    if (!configuredMcpName) {
      throw new ProviderInvestigationConfigurationError(
        `${CONNECTION_TRUEFORGE_GITHUB_MCP_ENV} must be configured.`,
      );
    }

    getConnectionRecoveryCoordinatorAgentSpec(environment);

    const ensured = await sessionService.ensureTrueForgeSession(incidentId);
    const upgraded = await sessionService.ensureCoordinatorForIncident(
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
        connectionId,
        providerDeliveryId: incident.externalDeliveryId,
        mcpServerName: configuredMcpName,
        skillName: CONNECTION_PROVIDER_INVESTIGATION_SKILL_NAME,
      },
    });

    let turnId: string | null = null;
    let providerThreadId: string | null = null;
    let toolCallId: string | null = null;
    let trueForgeEventId: string | null = null;

    let attemptNumber = 1;
    try {
      const collectAttempt = async (
        corrective: boolean,
      ): Promise<CollectedProviderTurn> => {
        const stream = await trueForgeClient.createTurnStream(
          upgraded.sessionId,
          {
            input: buildProviderInvestigationInput(
              connectionId,
              incident.externalDeliveryId,
              corrective,
            ),
          },
        );
        try {
          // The live stream is only a turn-creation/terminal-status channel.
          // Dynamic child events are read from the exact persisted turn after the
          // server reports the turn completed.
          const completedTurnId = await collectTurnLifecycle(
            stream,
            (attribution) => {
              turnId = attribution.turnId ?? turnId;
              trueForgeEventId =
                attribution.trueForgeEventId ?? trueForgeEventId;
            },
          );
          const persistedEvents = await trueForgeClient.listTurnEvents(
            upgraded.sessionId,
            completedTurnId,
          );
          return await collectProviderTurn(
            persistedEvents,
            completedTurnId,
            connectionId,
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
      };

      let collected: CollectedProviderTurn;
      while (true) {
        try {
          collected = await collectAttempt(attemptNumber === 2);
          break;
        } catch (error) {
          if (
            attemptNumber === 1 &&
            error instanceof ProviderInvestigationUnexpectedArgumentsError
          ) {
            appendFailure(
              workflowEvents.append,
              incidentId,
              upgraded.sessionId,
              turnId,
              providerThreadId,
              toolCallId,
              trueForgeEventId,
              error,
              { attempt: 1, retryEligible: true },
            );
            attemptNumber = 2;
            turnId = null;
            providerThreadId = null;
            toolCallId = null;
            trueForgeEventId = null;
            continue;
          }
          throw error;
        }
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
      // Extraction and normalization stay outside the write transaction. Only
      // the normalized snapshot and its matching provenance event are atomic.
      const normalizedEvidence = evidenceService.normalizeForIncident(
        incidentId,
        githubResult,
      );
      const evidenceJson = evidenceService.serializeEvidence(normalizedEvidence);
      const reconciliation = database.transaction(
        () => {
          const result = evidenceService.reconcileNormalizedEvidenceWithinTransaction(
            incidentId,
            normalizedEvidence,
            evidenceJson,
          );

          if (result.conflict !== null) {
            appendConflictEvent(
              workflowEvents.appendWithinTransaction,
              incidentId,
              upgraded.sessionId,
              collected.turnId,
              collected.thread,
              collected.toolCall,
              collected.toolResponse,
              result.conflict,
            );
          } else {
            appendEvidenceEvent(
              workflowEvents.appendWithinTransaction,
              incidentId,
              upgraded.sessionId,
              collected.turnId,
              collected.thread,
              collected.toolCall,
              collected.toolResponse,
              result.capture,
            );
          }

          return result;
        },
        "immediate",
      );

      if (reconciliation.conflict !== null) {
        // The conflict event is durable before the immutable-observation error
        // is exposed to callers.
        throw reconciliation.conflict;
      }

      const capture: ProviderEvidenceCaptureResult = reconciliation.capture;

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
      if (error instanceof TrueForgeTurnInProgressError) {
        throw error;
      }
      appendFailure(
        workflowEvents.append,
        incidentId,
        upgraded.sessionId,
        turnId,
        providerThreadId,
        toolCallId,
        trueForgeEventId,
        error,
        attemptNumber === 2
          ? { attempt: 2, retryEligible: false }
          : undefined,
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
