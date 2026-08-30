import { createHash, randomUUID } from "node:crypto";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  deriveRecoveryAssessment,
  PROVIDER_FAILED_RECEIVER_MUTATED,
} from "@/domain/recovery-assessment";
import type { RecoveryAttempt } from "@/domain/recovery-attempt";
import {
  parseRecoveryResultJson,
  type RecoveryResultArtifact,
  type RecoveryResultExpectedIdentity,
} from "@/domain/recovery-result";
import {
  getRecoverySandboxAgentSpec,
  REDRIVE_RECOVERY_SPEC_VERSION,
} from "@/agents/recovery-sandbox-agent";
import type { ProviderEvidence } from "@/domain/provider-evidence";
import type { ReceiverObservation } from "@/domain/receiver-observation";
import { getApplicationConnection } from "@/server/github-connection-service";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { createIncidentService } from "@/server/incident-service";
import { createProviderEvidenceService } from "@/server/provider-evidence-service";
import { createReceiverObservationService } from "@/server/receiver-observation-service";
import {
  createConfiguredTrueForgeClient,
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
  TrueForgeSessionNotFoundError,
  type TrueForgeIncidentClient,
} from "@/server/trueforge-client";
import {
  createRecoveryAttemptRepository,
  type RecoveryAttemptCreationInput,
} from "@/server/recovery-attempt-repository";
import { getServerConfig } from "@/server/config";

export const RECOVERY_SESSION_CREATION_STALE_AFTER_MS = 60 * 1000;

type RecoverySandboxClient = Pick<
  TrueForgeIncidentClient,
  | "createSession"
  | "getSession"
  | "updateSession"
  | "createTurnStream"
  | "listTurnEvents"
>;

export class RecoverySandboxIncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found.`);
    this.name = "RecoverySandboxIncidentNotFoundError";
  }
}

export class RecoverySandboxPrerequisiteError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Sandbox recovery prerequisite failed: ${message}`, options);
    this.name = "RecoverySandboxPrerequisiteError";
  }
}

export class RecoverySandboxAttemptStateError extends Error {
  readonly attempt: RecoveryAttempt;

  constructor(message: string, attempt: RecoveryAttempt) {
    super(message);
    this.name = "RecoverySandboxAttemptStateError";
    this.attempt = attempt;
  }
}

export class RecoverySandboxSessionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Recovery sandbox session is not ready: ${message}`, options);
    this.name = "RecoverySandboxSessionError";
  }
}

export class RecoverySandboxTurnError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(`Recovery sandbox turn was not valid: ${message}`, options);
    this.name = "RecoverySandboxTurnError";
  }
}

interface RecoverySandboxContext extends RecoveryResultExpectedIdentity {
  incidentId: string;
  applicationConnectionId: string;
}

interface RecoverySandboxTurn {
  turnId: string;
  resultText: string;
  artifact: RecoveryResultArtifact;
}

interface RecordValue {
  [key: string]: unknown;
}

function isRecord(value: unknown): value is RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(
  value: unknown,
  field: string,
  errorType: typeof RecoverySandboxTurnError | typeof RecoverySandboxSessionError = RecoverySandboxTurnError,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new errorType(`TrueForge event is missing a valid ${field}.`);
  }
  return value;
}

function eventType(event: unknown): string {
  if (!isRecord(event) || typeof event.type !== "string") {
    throw new RecoverySandboxTurnError("TrueForge emitted an event without a valid type.");
  }
  return event.type;
}

function assertExactSession(event: RecordValue, expectedSessionId: string): void {
  if (
    Object.prototype.hasOwnProperty.call(event, "sessionId") &&
    event.sessionId !== null &&
    event.sessionId !== expectedSessionId
  ) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery event belongs to a different session.",
    );
  }
}

function assertEventTurn(
  event: RecordValue,
  expectedTurnId: string,
  allowMissing = false,
): void {
  if (
    typeof event.turnId === "undefined" &&
    allowMissing
  ) {
    return;
  }
  if (event.turnId !== expectedTurnId) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery event belongs to a different turn.",
    );
  }
}

function readTurnStatus(event: RecordValue, expected: "running" | "done"): void {
  if (!isRecord(event.state) || event.state.status !== expected) {
    throw new RecoverySandboxTurnError(
      `TrueForge recovery turn did not contain the expected ${expected} state.`,
    );
  }
}

async function collectLiveTurnLifecycle(
  stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>,
  expectedSessionId: string,
): Promise<string> {
  let turnId: string | null = null;
  let created = false;
  let done = false;

  for await (const rawEvent of stream) {
    if (!isRecord(rawEvent)) {
      throw new RecoverySandboxTurnError("TrueForge emitted an invalid live event.");
    }
    assertExactSession(rawEvent, expectedSessionId);
    const type = eventType(rawEvent);
    if (done) {
      throw new RecoverySandboxTurnError("TrueForge emitted an event after turn.done.");
    }
    if (type === "turn.created") {
      if (created) {
        throw new RecoverySandboxTurnError(
          "TrueForge emitted more than one turn.created event.",
        );
      }
      turnId = requiredString(rawEvent.turnId, "turnId");
      readTurnStatus(rawEvent, "running");
      created = true;
      continue;
    }
    if (type === "turn.done") {
      if (!created || turnId === null) {
        throw new RecoverySandboxTurnError(
          "TrueForge emitted turn.done before turn.created.",
        );
      }
      assertEventTurn(rawEvent, turnId, true);
      if (done) {
        throw new RecoverySandboxTurnError(
          "TrueForge emitted more than one turn.done event.",
        );
      }
      readTurnStatus(rawEvent, "done");
      done = true;
      continue;
    }
  }

  if (!created || turnId === null || !done) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery stream did not contain one completed turn.",
    );
  }
  return turnId;
}

const SANDBOX_IO_TOOL_NAMES = new Set([
  "exec",
  "read_file",
  "write_file",
  "apply_patch",
  "list_files",
  "list_directory",
  "search_files",
]);
const ALLOWED_RECOVERY_TOOL_NAMES = new Set([
  ...SANDBOX_IO_TOOL_NAMES,
  "get_current_datetime",
]);
const RECOVERY_ARTIFACT_PATH = "/home/trueforge/evidence/artifact.json";

interface RecoveryToolCall {
  threadId: string;
  toolCallId: string;
  toolName: string;
  argumentsText: string;
}

function validateSandboxToolCall(
  rawToolCall: unknown,
  threadId: string,
  seenToolCallIds: Set<string>,
): RecoveryToolCall {
  if (!isRecord(rawToolCall) || rawToolCall.type !== "function") {
    throw new RecoverySandboxTurnError("TrueForge recovery tool call has an invalid shape.");
  }
  const functionValue = rawToolCall.function;
  const toolInfo = rawToolCall.toolInfo;
  if (
    typeof rawToolCall.id !== "string" ||
    rawToolCall.id.length === 0 ||
    !isRecord(functionValue) ||
    typeof functionValue.name !== "string" ||
    typeof functionValue.arguments !== "string" ||
    !isRecord(toolInfo) ||
    toolInfo.type !== "truefoundry-system" ||
    typeof toolInfo.name !== "string" ||
    (typeof toolInfo.serverName !== "undefined" &&
      toolInfo.serverName !== null) ||
    functionValue.name !== toolInfo.name ||
    !ALLOWED_RECOVERY_TOOL_NAMES.has(toolInfo.name)
  ) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery emitted a non-sandbox or malformed tool call.",
    );
  }
  if (seenToolCallIds.has(rawToolCall.id)) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery tool-call IDs are not unique within the turn.",
    );
  }
  seenToolCallIds.add(rawToolCall.id);
  return {
    threadId,
    toolCallId: rawToolCall.id,
    toolName: toolInfo.name,
    argumentsText: functionValue.arguments,
  };
}

function identifiesRecoveryArtifact(toolCall: RecoveryToolCall): boolean {
  if (toolCall.toolName !== "exec" && toolCall.toolName !== "read_file") {
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.argumentsText) as unknown;
  } catch {
    return false;
  }

  if (toolCall.toolName === "exec") {
    if (!isRecord(parsed) || typeof parsed.command !== "string") return false;
    const keys = Object.keys(parsed);
    return (
      parsed.command === `cat ${RECOVERY_ARTIFACT_PATH}` &&
      keys.every((key) => key === "command" || key === "intent") &&
      (typeof parsed.intent === "undefined" || typeof parsed.intent === "string")
    );
  }

  if (typeof parsed === "string") return parsed === RECOVERY_ARTIFACT_PATH;
  return (
    isRecord(parsed) &&
    Object.keys(parsed).length === 1 &&
    parsed.path === RECOVERY_ARTIFACT_PATH
  );
}

function parseArtifactToolResponse(
  content: string,
  expectedIdentity: RecoveryResultExpectedIdentity,
): RecoveryResultArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new RecoverySandboxTurnError(
      "the required sandbox artifact response was not valid JSON.",
      { cause: error },
    );
  }

  let artifactText = content;
  if (isRecord(parsed)) {
    if (parsed.isError === true || parsed.success === false) {
      throw new RecoverySandboxTurnError(
        "the required sandbox artifact read failed.",
      );
    }
    if (Object.prototype.hasOwnProperty.call(parsed, "response")) {
      const response = parsed.response;
      if (
        parsed.success !== true ||
        !isRecord(response) ||
        response.exitCode !== 0 ||
        typeof response.result !== "string"
      ) {
        throw new RecoverySandboxTurnError(
          "the required sandbox artifact exec did not succeed.",
        );
      }
      artifactText = response.result;
    } else {
      const exitCode = parsed.exitCode ?? parsed.exit_code;
      if (typeof exitCode !== "undefined") {
        if (exitCode !== 0 || typeof parsed.stdout !== "string") {
          throw new RecoverySandboxTurnError(
            "the required sandbox artifact exec did not succeed.",
          );
        }
        artifactText = parsed.stdout;
      } else if (typeof parsed.output === "string") {
        artifactText = parsed.output;
      }
    }
  }

  try {
    return parseRecoveryResultJson(artifactText, expectedIdentity);
  } catch (error) {
    throw new RecoverySandboxTurnError(
      "the required sandbox artifact response was not a valid recovery artifact.",
      { cause: error },
    );
  }
}

export async function collectRecoveryTurn(
  events: AsyncIterable<TrueForgeApi.SessionEvent>,
  expectedSessionId: string,
  expectedTurnId: string,
  expectedIdentity: RecoveryResultExpectedIdentity,
): Promise<RecoverySandboxTurn> {
  let turnCreated = false;
  let turnDone = false;
  let sandboxCreated = false;
  const eventIds = new Set<string>();
  const seenToolCallIds = new Set<string>();
  const toolCalls: RecoveryToolCall[] = [];
  const toolResponses: Array<{
    threadId: string;
    toolCallId: string;
    content: string;
    isError: boolean;
  }> = [];
  let finalResultText: string | null = null;

  for await (const rawEvent of events) {
    if (!isRecord(rawEvent)) {
      throw new RecoverySandboxTurnError("TrueForge emitted an invalid persisted event.");
    }
    assertExactSession(rawEvent, expectedSessionId);
    const type = eventType(rawEvent);
    if (turnDone) {
      throw new RecoverySandboxTurnError("TrueForge emitted an event after turn.done.");
    }
    const id = requiredString(rawEvent.id, "event id");
    if (eventIds.has(id)) {
      throw new RecoverySandboxTurnError(
        "TrueForge persisted recovery event IDs are not unique within the turn.",
      );
    }
    eventIds.add(id);

    if (type === "turn.created") {
      if (turnCreated) {
        throw new RecoverySandboxTurnError(
          "TrueForge emitted more than one persisted turn.created event.",
        );
      }
      assertEventTurn(rawEvent, expectedTurnId);
      readTurnStatus(rawEvent, "running");
      turnCreated = true;
      continue;
    }

    if (type === "turn.done") {
      assertEventTurn(rawEvent, expectedTurnId, true);
      readTurnStatus(rawEvent, "done");
      turnDone = true;
      continue;
    }

    if (type === "sandbox.created") {
      if (!turnCreated || sandboxCreated) {
        throw new RecoverySandboxTurnError(
          "TrueForge recovery emitted an invalid sandbox.created lifecycle event.",
        );
      }
      sandboxCreated = true;
      continue;
    }

    if (type === "model.message") {
      if (!turnCreated) {
        throw new RecoverySandboxTurnError(
          "TrueForge emitted a model message before turn.created.",
        );
      }
      assertEventTurn(rawEvent, expectedTurnId, true);
      const threadId = requiredString(rawEvent.threadId, "threadId");
      if (
        Object.prototype.hasOwnProperty.call(rawEvent, "toolCalls") &&
        !Array.isArray(rawEvent.toolCalls)
      ) {
        throw new RecoverySandboxTurnError(
          "TrueForge recovery model.message contained an invalid tool call list.",
        );
      }
      if (Array.isArray(rawEvent.toolCalls)) {
        for (const rawToolCall of rawEvent.toolCalls) {
          toolCalls.push(
            validateSandboxToolCall(rawToolCall, threadId, seenToolCallIds),
          );
        }
      }
      if (
        rawEvent.content !== null &&
        typeof rawEvent.content !== "undefined" &&
        typeof rawEvent.content !== "string"
      ) {
        throw new RecoverySandboxTurnError(
          "TrueForge recovery model.message content is not text.",
        );
      }
      if (typeof rawEvent.content === "string" && rawEvent.content.trim().length > 0) {
        finalResultText = rawEvent.content;
      }
      continue;
    }

    if (type === "tool.response") {
      assertEventTurn(rawEvent, expectedTurnId, true);
      if (typeof rawEvent.content !== "string") {
        throw new RecoverySandboxTurnError(
          "TrueForge recovery tool.response content is not text.",
        );
      }
      toolResponses.push({
        threadId: requiredString(rawEvent.threadId, "tool response threadId"),
        toolCallId: requiredString(rawEvent.toolCallId, "tool response toolCallId"),
        content: rawEvent.content,
        isError: rawEvent.isError === true,
      });
      continue;
    }

    throw new RecoverySandboxTurnError(
      `TrueForge recovery emitted unsupported event type ${type}.`,
    );
  }

  if (!turnCreated || !turnDone) {
    throw new RecoverySandboxTurnError(
      "TrueForge persisted recovery events did not contain one completed turn.",
    );
  }
  if (finalResultText === null) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery turn did not contain a final JSON result message.",
    );
  }
  const artifactReads = toolCalls.filter(identifiesRecoveryArtifact);
  if (artifactReads.length !== 1) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery turn did not contain exactly one required artifact read.",
    );
  }

  for (const toolCall of toolCalls) {
    const responses = toolResponses.filter(
      (response) =>
        response.threadId === toolCall.threadId &&
        response.toolCallId === toolCall.toolCallId,
    );
    if (responses.length !== 1) {
      throw new RecoverySandboxTurnError(
        "TrueForge recovery sandbox tool call did not have exactly one response.",
      );
    }
  }
  if (
    toolResponses.some(
      (response) =>
        !toolCalls.some(
          (toolCall) =>
            toolCall.threadId === response.threadId &&
            toolCall.toolCallId === response.toolCallId,
        ),
    )
  ) {
    throw new RecoverySandboxTurnError(
      "TrueForge recovery emitted a tool response without a matching sandbox call.",
    );
  }

  const artifactRead = artifactReads[0];
  const artifactResponse = toolResponses.find(
    (response) =>
      response.threadId === artifactRead.threadId &&
      response.toolCallId === artifactRead.toolCallId,
  );
  if (artifactResponse === undefined || artifactResponse.isError) {
    throw new RecoverySandboxTurnError(
      "the required sandbox artifact read did not have a successful response.",
    );
  }

  let authoritativeArtifact: RecoveryResultArtifact;
  try {
    authoritativeArtifact = parseArtifactToolResponse(
      artifactResponse.content,
      expectedIdentity,
    );
  } catch (error) {
    throw new RecoverySandboxTurnError(
      "the authoritative sandbox artifact was not valid.",
      { cause: error },
    );
  }

  let finalArtifact: RecoveryResultArtifact;
  try {
    finalArtifact = parseRecoveryResultJson(finalResultText, expectedIdentity);
  } catch (error) {
    throw new RecoverySandboxTurnError(
      "the final model message was not a strictly valid recovery artifact.",
      { cause: error },
    );
  }
  if (JSON.stringify(finalArtifact) !== JSON.stringify(authoritativeArtifact)) {
    throw new RecoverySandboxTurnError(
      "the final model artifact differs from the authoritative sandbox artifact.",
    );
  }

  return {
    turnId: expectedTurnId,
    resultText: JSON.stringify(authoritativeArtifact),
    artifact: authoritativeArtifact,
  };
}

function requiredRevision(providerEvidence: ProviderEvidence): string {
  if (providerEvidence.event !== "push") {
    throw new RecoverySandboxPrerequisiteError(
      "only GitHub push delivery evidence is supported.",
    );
  }
  if (!isRecord(providerEvidence.request.payload)) {
    throw new RecoverySandboxPrerequisiteError(
      "the persisted GitHub push payload is missing.",
    );
  }
  const revision = providerEvidence.request.payload.after;
  if (
    typeof revision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(revision)
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "the GitHub push payload does not contain a full after revision.",
    );
  }
  return revision;
}

function sourcePayloadRepositoryFullName(providerEvidence: ProviderEvidence): string {
  if (!isRecord(providerEvidence.request.payload)) {
    throw new RecoverySandboxPrerequisiteError(
      "the persisted GitHub push payload is missing.",
    );
  }
  const repository = providerEvidence.request.payload.repository;
  if (!isRecord(repository) || typeof repository.full_name !== "string" || repository.full_name.length === 0) {
    throw new RecoverySandboxPrerequisiteError(
      "the GitHub push payload repository full name is missing.",
    );
  }
  return repository.full_name;
}

function findReceiverObservation(
  observations: ReceiverObservation[],
  incidentId: string,
  connectionId: string,
  deliveryGuid: string,
): ReceiverObservation {
  const matching = observations.filter(
    (observation) =>
      observation.incidentId === incidentId &&
      observation.applicationConnectionId === connectionId &&
      observation.deliveryGuid === deliveryGuid,
  );
  const observation = matching.at(-1);
  if (observation === undefined) {
    throw new RecoverySandboxPrerequisiteError(
      "a correlated persisted receiver observation is required.",
    );
  }
  return observation;
}

function contextForIncident(
  database: SqliteDatabase,
  incidentId: string,
): RecoverySandboxContext {
  const incident = createIncidentService(database).getById(incidentId);
  if (incident === null) {
    throw new RecoverySandboxIncidentNotFoundError(incidentId);
  }
  if (incident.provider !== "github") {
    throw new RecoverySandboxPrerequisiteError(
      "only GitHub incidents are supported.",
    );
  }
  const connectionId = incident.applicationConnectionId;
  if (typeof connectionId !== "string" || connectionId.length === 0) {
    throw new RecoverySandboxPrerequisiteError(
      "a durable application connection is required.",
    );
  }
  const connection = getApplicationConnection(database, connectionId);
  if (
    connection === null ||
    connection.provider !== "github" ||
    connection.id !== connectionId ||
    connection.repositoryId !== incident.repositoryId
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "the application connection and incident repository identities do not correlate.",
    );
  }

  const providerEvidence = createProviderEvidenceService(database).getByIncidentId(
    incidentId,
  );
  if (providerEvidence === null) {
    throw new RecoverySandboxPrerequisiteError(
      "persisted provider evidence is required.",
    );
  }
  if (
    providerEvidence.providerDeliveryId !== incident.externalDeliveryId ||
    providerEvidence.incidentId !== incidentId ||
    providerEvidence.applicationConnectionId !== connectionId ||
    providerEvidence.outcome.statusCode !== 500
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "provider evidence does not match the supported failed delivery.",
    );
  }

  const receiverObservation = findReceiverObservation(
    createReceiverObservationService(database).listByIncidentId(incidentId),
    incidentId,
    connectionId,
    providerEvidence.deliveryGuid,
  );
  if (
    receiverObservation.mutationCount !== 1 ||
    receiverObservation.businessState !== "EXACTLY_ONE"
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "the persisted receiver observation is not exactly one mutation.",
    );
  }

  let assessment;
  try {
    assessment = deriveRecoveryAssessment(providerEvidence, receiverObservation);
  } catch (error) {
    throw new RecoverySandboxPrerequisiteError(
      "provider and receiver evidence correlation is invalid.",
      { cause: error },
    );
  }
  if (
    assessment.recoveryState !== "BLOCKED" ||
    assessment.contradiction !== PROVIDER_FAILED_RECEIVER_MUTATED
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "the persisted evidence does not yield the blocked contradiction.",
    );
  }

  const payloadRepositoryFullName = sourcePayloadRepositoryFullName(providerEvidence);
  if (payloadRepositoryFullName !== connection.repositoryFullName) {
    throw new RecoverySandboxPrerequisiteError(
      "the push payload repository does not match the application connection.",
    );
  }

  return {
    incidentId,
    applicationConnectionId: connectionId,
    sourceRepositoryFullName: connection.repositoryFullName,
    originalRevision: requiredRevision(providerEvidence),
    deliveryGuid: providerEvidence.deliveryGuid,
    providerStatusCode: providerEvidence.outcome.statusCode,
    receiverMutationCount: receiverObservation.mutationCount,
  };
}

function assertAttemptMatchesContext(
  attempt: RecoveryAttempt,
  context: RecoverySandboxContext,
): void {
  if (
    attempt.incidentId !== context.incidentId ||
    attempt.sourceRepositoryFullName !== context.sourceRepositoryFullName ||
    attempt.originalRevision !== context.originalRevision ||
    attempt.providerStatusCode !== context.providerStatusCode ||
    attempt.receiverPreCount !== context.receiverMutationCount ||
    attempt.deliveryGuid !== context.deliveryGuid
  ) {
    throw new RecoverySandboxPrerequisiteError(
      "the existing recovery attempt does not match current incident evidence.",
    );
  }
}

function recoveryTurnInput(
  context: RecoverySandboxContext,
): TrueForgeApi.TurnInputItem[] {
  const exactContext = {
    repositoryFullName: context.sourceRepositoryFullName,
    originalRevision: context.originalRevision,
    deliveryGuid: context.deliveryGuid,
    providerStatusCode: context.providerStatusCode,
    receiverMutationCount: context.receiverMutationCount,
  };
  return [
    {
      type: "user.message",
      content: [
        "Run the Redrive sandbox-only recovery procedure.",
        "These are the exact immutable recovery inputs. Do not select replacements:",
        JSON.stringify(exactContext),
        "Clone the repository implied by repositoryFullName and checkout the exact originalRevision.",
        "Use a reconstructed sandbox request, never claim raw-wire replay, and never call a provider, receiver, deployment, redelivery, approval, or other external tool.",
        "Before returning the artifact in this turn, you MUST call the sandbox exec tool to read /home/trueforge/evidence/artifact.json; this tool call is mandatory for sandbox attribution.",
        "Return only the required redrive.recovery.v1 JSON artifact after deterministic reproduction, minimum safe repair, and adversarial replay verification.",
      ].join("\n"),
    },
  ];
}

function parseCreatedSessionId(result: string | { id: string }): string {
  const id = typeof result === "string" ? result : result.id;
  if (typeof id !== "string" || id.length === 0) {
    throw new TrueForgeSessionCreateError(
      "AMBIGUOUS",
      "TrueForge returned a recovery session without a valid ID.",
    );
  }
  return id;
}

function parseLookedUpSessionId(response: unknown): string | null {
  if (!isRecord(response)) return null;
  if (typeof response.id === "string" && response.id.length > 0) return response.id;
  if (isRecord(response.data) && typeof response.data.id === "string" && response.data.id.length > 0) {
    return response.data.id;
  }
  return null;
}

function definitiveCreateFailure(error: unknown): boolean {
  return (
    error instanceof TrueForgeConfigurationError ||
    (error instanceof TrueForgeSessionCreateError && error.kind === "DEFINITIVE")
  );
}

function staleCreationCutoff(observedAt: string): string {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new RecoverySandboxSessionError(
      "the recovery reservation timestamp could not be evaluated.",
    );
  }
  return new Date(
    observedAtMs - RECOVERY_SESSION_CREATION_STALE_AFTER_MS,
  ).toISOString();
}

function isStaleCreation(attempt: RecoveryAttempt, observedAt: string): boolean {
  const createdAtMs = Date.parse(attempt.createdAt);
  const observedAtMs = Date.parse(observedAt);
  return (
    Number.isFinite(createdAtMs) &&
    Number.isFinite(observedAtMs) &&
    observedAtMs - createdAtMs >= RECOVERY_SESSION_CREATION_STALE_AFTER_MS
  );
}

function artifactFromAttempt(attempt: RecoveryAttempt): RecoveryResultArtifact {
  if (
    attempt.state !== "REPAIR_VERIFIED" ||
    attempt.resultJson === null ||
    attempt.patchText === null ||
    attempt.patchSha256 === null
  ) {
    throw new RecoverySandboxSessionError(
      "the verified attempt does not contain a complete durable artifact.",
    );
  }
  const artifact = parseRecoveryResultJson(attempt.resultJson, {
    sourceRepositoryFullName: attempt.sourceRepositoryFullName,
    originalRevision: attempt.originalRevision,
    deliveryGuid: attempt.deliveryGuid,
    providerStatusCode: attempt.providerStatusCode,
    receiverMutationCount: attempt.receiverPreCount,
  });
  if (artifact.patch !== attempt.patchText) {
    throw new RecoverySandboxSessionError(
      "the durable result and patch columns do not match.",
    );
  }
  const patchSha256 = createHash("sha256")
    .update(artifact.patch, "utf8")
    .digest("hex");
  if (patchSha256 !== attempt.patchSha256) {
    throw new RecoverySandboxSessionError(
      "the durable patch digest does not match the patch text.",
    );
  }
  return artifact;
}

export function createRecoverySandboxService(
  database: SqliteDatabase,
  trueForgeClient: RecoverySandboxClient,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
) {
  const attempts = createRecoveryAttemptRepository(database);

  async function reconcileReadySession(
    attempt: RecoveryAttempt,
    spec: TrueForgeApi.AgentSpec,
    lookupRemote = true,
  ): Promise<RecoveryAttempt> {
    if (attempt.trueForgeSessionId === null) {
      throw new RecoverySandboxSessionError("the READY attempt has no session ID.");
    }
    if (lookupRemote) {
      let session: unknown;
      try {
        session = await trueForgeClient.getSession(attempt.trueForgeSessionId);
      } catch (error) {
        if (error instanceof TrueForgeSessionNotFoundError) {
          const lost = attempts.markSessionLost(
            attempt.incidentId,
            attempt.trueForgeSessionId,
            now(),
          );
          throw new RecoverySandboxSessionError(
            "the remote session was not found and was marked SESSION_LOST.",
            { cause: lost === null ? error : undefined },
          );
        }
        throw new RecoverySandboxSessionError(
          "the remote session lookup failed without changing its durable identity.",
          { cause: error },
        );
      }
      if (parseLookedUpSessionId(session) !== attempt.trueForgeSessionId) {
        throw new RecoverySandboxSessionError(
          "the remote session lookup returned a different identity.",
        );
      }
    }
    try {
      await trueForgeClient.updateSession(attempt.trueForgeSessionId, spec);
    } catch (error) {
      throw new RecoverySandboxSessionError(
        "the current recovery AgentSpec could not be reconciled.",
        { cause: error },
      );
    }
    if (attempt.recoverySpecVersion !== REDRIVE_RECOVERY_SPEC_VERSION) {
      const updated = attempts.updateSpecVersion(
        attempt.incidentId,
        attempt.trueForgeSessionId,
        attempt.recoverySpecVersion,
        REDRIVE_RECOVERY_SPEC_VERSION,
        now(),
      );
      if (updated === null) {
        throw new RecoverySandboxSessionError(
          "the durable recovery AgentSpec version changed during reconciliation.",
        );
      }
      return updated;
    }
    return attempt;
  }

  async function createOrReuseSession(
    context: RecoverySandboxContext,
    spec: TrueForgeApi.AgentSpec,
  ): Promise<RecoveryAttempt> {
    let attempt = attempts.getByIncidentId(context.incidentId);
    if (attempt !== null) {
      assertAttemptMatchesContext(attempt, context);
      if (attempt.state === "READY") return reconcileReadySession(attempt, spec);
      if (attempt.state === "SESSION_CREATING") {
        const observedAt = now();
        if (
          attempt.creationToken !== null &&
          isStaleCreation(attempt, observedAt)
        ) {
          attempts.markStaleCreationUncertain(
            context.incidentId,
            attempt.creationToken,
            attempt.createdAt,
            staleCreationCutoff(observedAt),
            observedAt,
          );
          const uncertain = attempts.getByIncidentId(context.incidentId);
          if (uncertain !== null) {
            if (uncertain.state === "READY") {
              return reconcileReadySession(uncertain, spec);
            }
            throw new RecoverySandboxAttemptStateError(
              "A stale recovery session reservation was fenced as SESSION_UNCERTAIN; remote creation will not be retried.",
              uncertain,
            );
          }
        }
        throw new RecoverySandboxAttemptStateError(
          "A recovery session reservation is already owned by another creator.",
          attempt,
        );
      }
      throw new RecoverySandboxAttemptStateError(
        `Recovery attempt is ${attempt.state} and cannot start another turn.`,
        attempt,
      );
    }

    const creationToken = randomUUID();
    const input: RecoveryAttemptCreationInput = {
      id: randomUUID(),
      incidentId: context.incidentId,
      creationToken,
      recoverySpecVersion: REDRIVE_RECOVERY_SPEC_VERSION,
      sourceRepositoryFullName: context.sourceRepositoryFullName,
      originalRevision: context.originalRevision,
      providerStatusCode: context.providerStatusCode,
      receiverPreCount: context.receiverMutationCount,
      deliveryGuid: context.deliveryGuid,
      createdAt: now(),
    };
    attempt = attempts.reserveCreation(input);
    if (
      attempt.state !== "SESSION_CREATING" ||
      attempt.creationToken !== creationToken
    ) {
      assertAttemptMatchesContext(attempt, context);
      throw new RecoverySandboxAttemptStateError(
        "A recovery session reservation is already owned by another creator.",
        attempt,
      );
    }

    let sessionId: string;
    try {
      sessionId = parseCreatedSessionId(
        await trueForgeClient.createSession(spec),
      );
    } catch (error) {
      if (definitiveCreateFailure(error)) {
        attempts.releaseCreation(context.incidentId, creationToken);
        throw error;
      }
      attempts.markCreationUncertain(context.incidentId, creationToken, now());
      throw new RecoverySandboxSessionError(
        "session creation had an ambiguous outcome and was fenced as SESSION_UNCERTAIN.",
        { cause: error },
      );
    }
    const activated = attempts.activate(
      context.incidentId,
      creationToken,
      sessionId,
      now(),
    );
    if (activated === null) {
      throw new RecoverySandboxSessionError(
        "the session creation result could not be fenced to its reservation owner.",
      );
    }
    return reconcileReadySession(activated, spec, false);
  }

  async function startOrResumeSandboxRecovery(
    incidentId: string,
  ): Promise<{ attempt: RecoveryAttempt; artifact: RecoveryResultArtifact }> {
    const existing = attempts.getByIncidentId(incidentId);
    if (existing?.state === "REPAIR_VERIFIED") {
      return { attempt: existing, artifact: artifactFromAttempt(existing) };
    }

    const context = contextForIncident(database, incidentId);
    if (existing !== null) assertAttemptMatchesContext(existing, context);
    const spec = getRecoverySandboxAgentSpec(environment);
    let attempt = await createOrReuseSession(context, spec);
    if (attempt.state !== "READY" || attempt.trueForgeSessionId === null) {
      throw new RecoverySandboxAttemptStateError(
        "The recovery session is not READY for a sandbox turn.",
        attempt,
      );
    }
    const running = attempts.markRunning(
      context.incidentId,
      attempt.trueForgeSessionId,
      now(),
    );
    if (running === null) {
      const current = attempts.getByIncidentId(context.incidentId);
      if (current === null) {
        throw new RecoverySandboxSessionError("the recovery attempt disappeared before its turn.");
      }
      if (current.state === "REPAIR_VERIFIED") {
        return { attempt: current, artifact: artifactFromAttempt(current) };
      }
      throw new RecoverySandboxAttemptStateError(
        "Another recovery turn owns the durable RUNNING state.",
        current,
      );
    }
    attempt = running;
    const sessionId = running.trueForgeSessionId;
    if (sessionId === null) {
      throw new RecoverySandboxSessionError(
        "the RUNNING attempt has no session ID.",
      );
    }

    let completedTurnId: string;
    try {
      const stream = await trueForgeClient.createTurnStream(
        sessionId,
        { input: recoveryTurnInput(context) },
      );
      completedTurnId = await collectLiveTurnLifecycle(
        stream,
        sessionId,
      );
    } catch (error) {
      throw new RecoverySandboxTurnError(
        "turn creation or live completion was uncertain; the RUNNING attempt was left fenced.",
        { cause: error },
      );
    }

    let turn: RecoverySandboxTurn;
    try {
      const persistedEvents = await trueForgeClient.listTurnEvents(
        sessionId,
        completedTurnId,
      );
      turn = await collectRecoveryTurn(
        persistedEvents,
        sessionId,
        completedTurnId,
        context,
      );
    } catch (error) {
      if (error instanceof RecoverySandboxTurnError) {
        attempts.markFailed(
          context.incidentId,
          sessionId,
          "INVALID_TURN_ARTIFACT",
          now(),
        );
        throw error;
      }
      throw new RecoverySandboxTurnError(
        "persisted recovery events could not be read; the RUNNING attempt was left fenced.",
        { cause: error },
      );
    }

    const patchSha256 = createHash("sha256")
      .update(turn.artifact.patch, "utf8")
      .digest("hex");
    const resultJson = turn.resultText;
    const verified = attempts.markVerified(
      context.incidentId,
      sessionId,
      turn.turnId,
      resultJson,
      turn.artifact.patch,
      patchSha256,
      turn.artifact.reproduction,
      turn.artifact.verification,
      now(),
    );
    if (verified === null) {
      const current = attempts.getByIncidentId(context.incidentId);
      throw new RecoverySandboxTurnError(
        "the verified recovery artifact could not be durably persisted.",
        { cause: current },
      );
    }
    return { attempt: verified, artifact: turn.artifact };
  }

  return {
    getByIncidentId: attempts.getByIncidentId,
    startOrResumeSandboxRecovery,
  };
}

type RecoverySandboxService = ReturnType<typeof createRecoverySandboxService>;

function withConfiguredService<T>(
  operation: (service: RecoverySandboxService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(createRecoverySandboxService(database, createConfiguredTrueForgeClient()));
}

export async function startSandboxRecovery(
  incidentId: string,
): Promise<{ attempt: RecoveryAttempt; artifact: RecoveryResultArtifact }> {
  return withConfiguredService((service) =>
    service.startOrResumeSandboxRecovery(incidentId),
  );
}

export async function getRecoveryAttempt(
  incidentId: string,
): Promise<RecoveryAttempt | null> {
  return withConfiguredService((service) => service.getByIncidentId(incidentId));
}
