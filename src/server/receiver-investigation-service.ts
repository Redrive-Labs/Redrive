import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  parseBusinessStateReadResult,
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  ReceiverConnectorValidationError,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";
import {
  CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV,
  getConnectionRecoveryCoordinatorAgentSpec,
} from "@/agents/recovery-coordinator";
import { RECEIVER_MCP_BUSINESS_STATE_TOOL } from "@/server/receiver-mcp-server";
import {
  createReceiverObservationService,
  type ReceiverObservationCaptureResult,
} from "@/server/receiver-observation-service";
import { createIncidentService } from "@/server/incident-service";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";
import {
  createConfiguredTrueForgeClient,
  type TrueForgeIncidentClient,
} from "@/server/trueforge-client";
import {
  createTrueForgeSessionService,
  TrueForgeSessionMismatchError,
  TrueForgeSessionUnavailableError,
} from "@/server/trueforge-session-service";
import { IncidentNotFoundError } from "@/server/provider-evidence-service";

export const RECEIVER_INVESTIGATOR_NAME = "receiver-investigator" as const;
const CREATE_SUB_AGENT_TOOL = "create_sub_agent" as const;

export class ReceiverInvestigationConfigurationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReceiverInvestigationConfigurationError";
  }
}

export class ReceiverInvestigationTurnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReceiverInvestigationTurnError";
  }
}

export class ReceiverInvestigationEvidenceError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ReceiverInvestigationEvidenceError";
  }
}

export interface ReceiverInvestigationDeterministicInput {
  connectionId: string;
  deliveryGuid: string;
  expectedSessionId: string;
}

export interface ReceiverInvestigationResult {
  incidentId: string;
  trueForgeSessionId: string;
  turnId: string;
  receiverInvestigatorThreadId: string;
  observationDisposition: "CAPTURED" | "REPLAYED";
  observation: ReceiverObservationCaptureResult["observation"];
}

interface RecordValue {
  [key: string]: unknown;
}

interface ReceiverInvestigatorThread {
  threadId: string;
  eventId: string;
  createdAt: string;
  parentThreadId: string;
  parentToolCallId: string;
  agentName: string;
  input: string;
}

interface ReceiverToolArguments {
  connection_id: string;
  delivery_guid: string;
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

interface ReceiverToolResponse {
  eventId: string;
  createdAt: string;
  threadId: string;
  toolCallId: string;
  content: string;
}

interface CollectedReceiverTurn {
  turnId: string;
  thread: ReceiverInvestigatorThread;
  toolCall: ObservedToolCall & { arguments: ReceiverToolArguments };
  toolResponse: ReceiverToolResponse;
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
    throw new ReceiverInvestigationTurnError(
      `TrueForge ${description} is missing a valid ${field}.`,
    );
  }
  return value;
}

function eventType(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") {
    throw new ReceiverInvestigationTurnError(
      "TrueForge emitted an event without a valid type.",
    );
  }
  return event.type;
}

function parseExactObject(
  parsed: unknown,
  description: string,
  expectedKeys: readonly string[],
): RecordValue {
  if (!isRecord(parsed)) {
    throw new ReceiverInvestigationTurnError(
      `TrueForge ${description} arguments must be an object.`,
    );
  }
  const keys = Object.keys(parsed);
  const expected = new Set(expectedKeys);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))
  ) {
    throw new ReceiverInvestigationTurnError(
      `TrueForge ${description} arguments contain unexpected or missing fields.`,
    );
  }
  return parsed;
}

function parseExactJsonObject(
  text: string,
  description: string,
  expectedKeys: readonly string[],
): RecordValue {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new ReceiverInvestigationTurnError(
      `TrueForge ${description} arguments are not valid JSON.`,
    );
  }
  return parseExactObject(parsed, description, expectedKeys);
}

function parseReceiverToolArguments(
  toolCall: ObservedToolCall,
  expectedConnectionId: string,
  expectedDeliveryGuid: string,
  expectedMcpServerName: string,
): ReceiverToolArguments {
  let parsed: RecordValue;
  if (toolCall.toolInfoType === "mcp") {
    if (
      toolCall.toolInfoServerName !== expectedMcpServerName ||
      toolCall.toolInfoName !== RECEIVER_MCP_BUSINESS_STATE_TOOL ||
      toolCall.functionName !== RECEIVER_MCP_BUSINESS_STATE_TOOL
    ) {
      throw new ReceiverInvestigationTurnError(
        "Receiver Investigator did not call the configured read-only business-state MCP tool.",
      );
    }
    parsed = parseExactJsonObject(
      toolCall.argumentsText,
      "Receiver Investigator MCP tool",
      ["connection_id", "delivery_guid"],
    );
  } else if (toolCall.toolInfoType === "truefoundry-system") {
    if (
      toolCall.toolInfoName !== "call_tool" ||
      toolCall.functionName !== "call_tool"
    ) {
      throw new ReceiverInvestigationTurnError(
        "Receiver Investigator did not call the configured Receiver MCP tool through the TrueForge system wrapper.",
      );
    }
    const wrapper = parseExactJsonObject(
      toolCall.argumentsText,
      "Receiver Investigator MCP wrapper",
      ["mcp_server", "tool_name", "input"],
    );
    if (
      wrapper.mcp_server !== expectedMcpServerName ||
      wrapper.tool_name !== RECEIVER_MCP_BUSINESS_STATE_TOOL
    ) {
      throw new ReceiverInvestigationTurnError(
        "Receiver Investigator TrueForge MCP wrapper did not identify the configured business-state tool.",
      );
    }
    parsed = parseExactObject(
      wrapper.input,
      "Receiver Investigator MCP wrapper input",
      ["connection_id", "delivery_guid"],
    );
  } else {
    throw new ReceiverInvestigationTurnError(
      "Receiver Investigator did not use a supported MCP tool event shape.",
    );
  }
  if (
    typeof parsed.connection_id !== "string" ||
    parsed.connection_id.length === 0 ||
    typeof parsed.delivery_guid !== "string" ||
    parsed.delivery_guid.length === 0
  ) {
    throw new ReceiverInvestigationTurnError(
      "Receiver Investigator MCP tool arguments must contain non-empty string identifiers.",
    );
  }
  if (
    parsed.connection_id !== expectedConnectionId ||
    parsed.delivery_guid !== expectedDeliveryGuid
  ) {
    throw new ReceiverInvestigationTurnError(
      "Receiver Investigator MCP tool arguments do not match the deterministic incident lookup.",
    );
  }
  return {
    connection_id: expectedConnectionId,
    delivery_guid: expectedDeliveryGuid,
  };
}

function parseCreateSubAgentArguments(
  argumentsText: string,
): { input: string } {
  const parsed = parseExactJsonObject(
    argumentsText,
    "create_sub_agent",
    ["name", "input"],
  );
  if (
    parsed.name !== RECEIVER_INVESTIGATOR_NAME ||
    typeof parsed.input !== "string" ||
    parsed.input.length === 0
  ) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge create_sub_agent did not carry a valid receiver investigator task.",
    );
  }
  return { input: parsed.input };
}

/**
 * The child task is intentionally only the deterministic opaque lookup tuple.
 * The Receiver Skill and Coordinator instructions define a role-separated,
 * independently authenticated evidence boundary with deterministic
 * fail-closed tool correlation; static SDK resource exposure does not prove
 * per-child MCP filtering.
 */
export function buildReceiverInvestigatorTask(
  connectionId: string,
  deliveryGuid: string,
): string {
  return JSON.stringify({
    connection_id: connectionId,
    delivery_guid: deliveryGuid,
  });
}

export function buildReceiverInvestigationInput(
  connectionId: string,
  deliveryGuid: string,
): TrueForgeApi.TurnInputItem[] {
  const task = buildReceiverInvestigatorTask(connectionId, deliveryGuid);
  return [
    {
      type: "user.message",
      content: [
        "Run the connection-backed receiver-only investigation.",
        "Use the following exact opaque lookup tuple; do not choose, discover, normalize, or replace either value.",
        `connection_id=${connectionId}`,
        `delivery_guid=${deliveryGuid}`,
        `Create exactly one dynamic subagent named ${RECEIVER_INVESTIGATOR_NAME}. Its task input must be exactly: ${task}`,
        `That subagent, and only that subagent, must call ${RECEIVER_MCP_BUSINESS_STATE_TOOL} on the configured Receiver MCP server exactly once with exactly connection_id and delivery_guid.`,
        "Do not call health, provider, repair, deploy, approval, redelivery, or any write or consequential tool.",
        "The correlated machine tool.response is authoritative receiver evidence; agent prose is not evidence.",
      ].join("\n"),
    },
  ];
}

export function extractBusinessStateFromTrueForgeToolResponse(
  content: string,
  expectedDeliveryGuid: string,
): BusinessStateReadResult {
  if (typeof content !== "string" || content.trim().length === 0) {
    throw new ReceiverInvestigationEvidenceError(
      "TrueForge Receiver tool.response content must be a non-empty JSON string.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch {
    throw new ReceiverInvestigationEvidenceError(
      "TrueForge Receiver tool.response content is not valid JSON.",
    );
  }

  try {
    return parseBusinessStateReadResult(parsed, expectedDeliveryGuid);
  } catch (error) {
    if (error instanceof ReceiverConnectorValidationError) {
      throw new ReceiverInvestigationEvidenceError(
        "TrueForge Receiver tool.response did not contain the exact business state result.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function collectTurnLifecycle(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
): Promise<string> {
  let turnId: string | null = null;
  let turnCreated = false;
  let turnDone = false;

  for await (const event of stream) {
    if (turnDone) {
      throw new ReceiverInvestigationTurnError(
        "TrueForge emitted an event after turn.done.",
      );
    }
    const type = eventType(event);
    if (!isRecord(event)) {
      throw new ReceiverInvestigationTurnError(
        "TrueForge emitted an invalid event.",
      );
    }

    if (type === "turn.created") {
      if (turnCreated) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge emitted more than one turn.created event for the receiver turn.",
        );
      }
      turnId = requiredString(event, "turnId", "turn.created event");
      if (!isRecord(event.state) || event.state.status !== "running") {
        throw new ReceiverInvestigationTurnError(
          "TrueForge receiver turn.created did not contain a running state.",
        );
      }
      turnCreated = true;
      continue;
    }

    if (type === "turn.done") {
      if (turnDone) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge emitted more than one turn.done event for the receiver turn.",
        );
      }
      if (!isRecord(event.state) || event.state.status !== "done") {
        throw new ReceiverInvestigationTurnError(
          "TrueForge receiver turn did not finish normally.",
        );
      }
      turnDone = true;
    }
  }

  if (!turnCreated || turnId === null) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge receiver turn stream did not identify its turn.",
    );
  }
  if (!turnDone) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge receiver turn stream ended without turn.done.",
    );
  }
  return turnId;
}

export async function collectReceiverTurn(
  stream: AsyncIterable<TrueForgeApi.SessionEvent>,
  expectedTurnId: string,
  expectedConnectionId: string,
  expectedDeliveryGuid: string,
  expectedMcpServerName: string,
): Promise<CollectedReceiverTurn> {
  let turnId: string | null = null;
  let turnCreated = false;
  let turnDone = false;
  const threads: ReceiverInvestigatorThread[] = [];
  const observedToolCalls: ObservedToolCall[] = [];
  const toolResponses: ReceiverToolResponse[] = [];
  const eventIds = new Set<string>();
  const dynamicThreadIds = new Set<string>();
  const toolCallIds = new Set<string>();

  for await (const event of stream) {
    const type = eventType(event);
    if (turnDone) {
      throw new ReceiverInvestigationTurnError(
        "TrueForge emitted an event after turn.done.",
      );
    }
    if (!isRecord(event)) {
      throw new ReceiverInvestigationTurnError(
        "TrueForge emitted an invalid persisted receiver event.",
      );
    }
    const persistedEventId = requiredString(
      event,
      "id",
      "persisted receiver event",
    );
    if (eventIds.has(persistedEventId)) {
      throw new ReceiverInvestigationTurnError(
        "TrueForge persisted receiver event IDs are not unique within the completed turn.",
      );
    }
    eventIds.add(persistedEventId);

    if (type === "turn.created") {
      if (turnCreated) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge emitted more than one persisted turn.created event for the receiver turn.",
        );
      }
      const persistedTurnId = requiredString(
        event,
        "turnId",
        "turn.created event",
      );
      if (persistedTurnId !== expectedTurnId) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge persisted receiver events do not match the completed live turn.",
        );
      }
      if (!isRecord(event.state) || event.state.status !== "running") {
        throw new ReceiverInvestigationTurnError(
          "TrueForge persisted receiver turn.created did not contain a running state.",
        );
      }
      turnId = persistedTurnId;
      turnCreated = true;
      continue;
    }

    if (type === "thread.created") {
      const agentInfo = event.agentInfo;
      const parent = event.parent;
      if (!isRecord(agentInfo) || !isRecord(parent)) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge receiver thread.created did not contain dynamic-agent attribution.",
        );
      }
      if (
        agentInfo.type !== "dynamic" ||
        typeof agentInfo.name !== "string" ||
        agentInfo.name.length === 0 ||
        typeof agentInfo.input !== "string" ||
        agentInfo.input.length === 0
      ) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge receiver thread.created did not identify a dynamic subagent.",
        );
      }
      const threadId = requiredString(event, "threadId", "thread.created event");
      if (dynamicThreadIds.has(threadId)) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge dynamic receiver thread IDs are not unique within the completed turn.",
        );
      }
      dynamicThreadIds.add(threadId);
      threads.push({
        threadId,
        eventId: persistedEventId,
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
        input: agentInfo.input,
      });
      continue;
    }

    if (type === "model.message") {
      const threadId = requiredString(event, "threadId", "model.message event");
      if (
        Object.prototype.hasOwnProperty.call(event, "toolCalls") &&
        !Array.isArray(event.toolCalls)
      ) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge receiver model.message contained an invalid tool call list.",
        );
      }
      if (!Array.isArray(event.toolCalls)) continue;

      const modelMessageId = requiredString(
        event,
        "id",
        "model.message event",
      );
      for (const rawToolCall of event.toolCalls) {
        if (!isRecord(rawToolCall)) {
          throw new ReceiverInvestigationTurnError(
            "TrueForge receiver model.message contained an invalid tool call.",
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
          throw new ReceiverInvestigationTurnError(
            "TrueForge receiver model.message contained an invalid tool call shape.",
          );
        }
        if (toolCallIds.has(rawToolCall.id)) {
          throw new ReceiverInvestigationTurnError(
            "TrueForge receiver tool-call IDs are not unique within the completed turn.",
          );
        }
        toolCallIds.add(rawToolCall.id);
        observedToolCalls.push({
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
        });
      }
      continue;
    }

    if (type === "tool.response") {
      toolResponses.push({
        eventId: persistedEventId,
        createdAt: requiredString(event, "createdAt", "tool.response event"),
        threadId: requiredString(event, "threadId", "tool.response event"),
        toolCallId: requiredString(
          event,
          "toolCallId",
          "tool.response event",
        ),
        content:
          typeof event.content === "string"
            ? event.content
            : (() => {
                throw new ReceiverInvestigationTurnError(
                  "TrueForge receiver tool.response event contained invalid content.",
                );
              })(),
      });
      continue;
    }

    if (type === "turn.done") {
      if (turnDone) {
        throw new ReceiverInvestigationTurnError(
          "TrueForge emitted more than one persisted turn.done event for the receiver turn.",
        );
      }
      if (!isRecord(event.state) || event.state.status !== "done") {
        throw new ReceiverInvestigationTurnError(
          "TrueForge persisted receiver turn did not finish normally.",
        );
      }
      turnDone = true;
    }
  }

  if (!turnCreated || turnId === null || !turnDone) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge persisted receiver events did not contain one completed turn.",
    );
  }
  if (
    threads.length !== 1 ||
    threads[0].agentName !== RECEIVER_INVESTIGATOR_NAME
  ) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge did not create exactly one receiver-investigator dynamic thread.",
    );
  }
  const thread = threads[0];

  const parentToolCalls = observedToolCalls.filter(
    (toolCall) => toolCall.threadId !== thread.threadId,
  );
  if (
    parentToolCalls.length !== 1 ||
    parentToolCalls[0].threadId !== "main" ||
    thread.parentThreadId !== "main" ||
    parentToolCalls[0].threadId !== thread.parentThreadId ||
    parentToolCalls[0].toolCallId !== thread.parentToolCallId ||
    parentToolCalls[0].toolInfoType !== "truefoundry-system" ||
    parentToolCalls[0].toolInfoName !== CREATE_SUB_AGENT_TOOL ||
    parentToolCalls[0].functionName !== CREATE_SUB_AGENT_TOOL
  ) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge did not correlate exactly one root create_sub_agent call to receiver-investigator.",
    );
  }
  const parentArguments = parseCreateSubAgentArguments(
    parentToolCalls[0].argumentsText,
  );
  if (parentArguments.input !== thread.input) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge create_sub_agent input did not match the receiver thread input.",
    );
  }

  const receiverToolCalls = observedToolCalls.filter(
    (toolCall) => toolCall.threadId === thread.threadId,
  );
  if (receiverToolCalls.length !== 1) {
    throw new ReceiverInvestigationTurnError(
      "Receiver Investigator did not make exactly one MCP call.",
    );
  }
  const observedToolCall = receiverToolCalls[0];
  const receiverArguments = parseReceiverToolArguments(
    observedToolCall,
    expectedConnectionId,
    expectedDeliveryGuid,
    expectedMcpServerName,
  );

  const matchingResponses = toolResponses.filter(
    (response) =>
      response.threadId === thread.threadId &&
      response.toolCallId === observedToolCall.toolCallId,
  );
  if (
    matchingResponses.length !== 1 ||
    matchingResponses[0].content.trim().length === 0
  ) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge did not emit exactly one matching Receiver Investigator tool.response.",
    );
  }

  const unrelatedResponses = toolResponses.filter(
    (response) =>
      response.threadId !== thread.threadId ||
      response.toolCallId !== observedToolCall.toolCallId,
  );
  if (
    unrelatedResponses.length > 1 ||
    unrelatedResponses.some(
      (response) =>
        response.threadId !== thread.parentThreadId ||
        response.toolCallId !== thread.parentToolCallId ||
        response.content !== "",
    )
  ) {
    throw new ReceiverInvestigationTurnError(
      "TrueForge emitted an unrelated or duplicate receiver tool.response.",
    );
  }

  return {
    turnId,
    thread,
    toolCall: {
      ...observedToolCall,
      arguments: receiverArguments,
    },
    toolResponse: matchingResponses[0],
  };
}

function requireDeterministicInput(
  input: ReceiverInvestigationDeterministicInput,
): void {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length === 0) {
      throw new ReceiverInvestigationConfigurationError(
        `Receiver investigation ${field} must be a non-empty opaque string.`,
      );
    }
  }
}

type ReconciledCoordinator = Awaited<
  ReturnType<
    ReturnType<
      typeof createTrueForgeSessionService
    >["reconcileExistingCoordinatorForIncident"]
  >
>;

function requireUsableSession(
  incidentId: string,
  result: ReconciledCoordinator,
  expectedSessionId: string,
): asserts result is ReconciledCoordinator & {
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
  if (result.sessionId !== expectedSessionId) {
    throw new TrueForgeSessionMismatchError(incidentId);
  }
}

export function createReceiverInvestigationService(
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
  const observationService = createReceiverObservationService(database, now);

  async function investigate(
    incidentId: string,
    input: ReceiverInvestigationDeterministicInput,
  ): Promise<ReceiverInvestigationResult> {
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new IncidentNotFoundError(incidentId);
    }
    requireDeterministicInput(input);
    if (incident.applicationConnectionId !== input.connectionId) {
      throw new ReceiverInvestigationConfigurationError(
        "Receiver investigation connection input does not match the incident.",
      );
    }

    const receiverMcpName =
      environment[CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV]?.trim();
    if (!receiverMcpName) {
      throw new ReceiverInvestigationConfigurationError(
        `${CONNECTION_TRUEFORGE_RECEIVER_MCP_ENV} must be configured.`,
      );
    }
    try {
      getConnectionRecoveryCoordinatorAgentSpec(environment);
    } catch (error) {
      throw new ReceiverInvestigationConfigurationError(
        "The M2.7 Coordinator receiver configuration is incomplete.",
        { cause: error },
      );
    }

    const reconciled =
      await sessionService.reconcileExistingCoordinatorForIncident(
        incidentId,
        input.expectedSessionId,
      );
    requireUsableSession(incidentId, reconciled, input.expectedSessionId);

    let completedTurnId: string;
    let persistedEvents: AsyncIterable<TrueForgeApi.SessionEvent>;
    try {
      const stream = await trueForgeClient.createTurnStream(
        reconciled.sessionId,
        {
          input: buildReceiverInvestigationInput(
            input.connectionId,
            input.deliveryGuid,
          ),
        },
      );
      completedTurnId = await collectTurnLifecycle(stream);
      persistedEvents = await trueForgeClient.listTurnEvents(
        reconciled.sessionId,
        completedTurnId,
      );
    } catch (error) {
      if (error instanceof ReceiverInvestigationTurnError) throw error;
      throw new ReceiverInvestigationTurnError(
        "TrueForge receiver investigation events could not be collected.",
        { cause: error },
      );
    }

    let collected: CollectedReceiverTurn;
    try {
      collected = await collectReceiverTurn(
        persistedEvents,
        completedTurnId,
        input.connectionId,
        input.deliveryGuid,
        receiverMcpName,
      );
    } catch (error) {
      if (error instanceof ReceiverInvestigationTurnError) throw error;
      throw new ReceiverInvestigationTurnError(
        "TrueForge receiver investigation events could not be correlated.",
        { cause: error },
      );
    }

    const businessState = extractBusinessStateFromTrueForgeToolResponse(
      collected.toolResponse.content,
      input.deliveryGuid,
    );
    const capture = observationService.append({
      incidentId,
      applicationConnectionId: input.connectionId,
      deliveryGuid: input.deliveryGuid,
      capability: RECEIVER_CAPABILITY_BUSINESS_STATE,
      tool: RECEIVER_MCP_BUSINESS_STATE_TOOL,
      mcpServerName: receiverMcpName,
      result: businessState,
      trueForgeSessionId: reconciled.sessionId,
      turnId: collected.turnId,
      receiverInvestigatorThreadId: collected.thread.threadId,
      threadCreatedEventId: collected.thread.eventId,
      toolCallId: collected.toolCall.toolCallId,
      toolCallEventId: collected.toolCall.eventId,
      toolResponseEventId: collected.toolResponse.eventId,
      toolResponseCreatedAt: collected.toolResponse.createdAt,
      createdAt: now(),
    });

    return {
      incidentId,
      trueForgeSessionId: reconciled.sessionId,
      turnId: collected.turnId,
      receiverInvestigatorThreadId: collected.thread.threadId,
      observationDisposition: capture.disposition,
      observation: capture.observation,
    };
  }

  return {
    investigateReceiverForIncident: investigate,
    getObservations: observationService.listByIncidentId,
  };
}

type ReceiverInvestigationService = ReturnType<
  typeof createReceiverInvestigationService
>;

function withConfiguredService<T>(
  operation: (service: ReceiverInvestigationService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(
    createReceiverInvestigationService(
      database,
      createConfiguredTrueForgeClient(),
    ),
  );
}

export async function investigateReceiverForIncident(
  incidentId: string,
  input: ReceiverInvestigationDeterministicInput,
): Promise<ReceiverInvestigationResult> {
  return withConfiguredService((service) =>
    service.investigateReceiverForIncident(incidentId, input),
  );
}
