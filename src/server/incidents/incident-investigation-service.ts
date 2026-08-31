import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { deriveRecoveryAssessment, type RecoveryAssessment } from "@/domain/recovery-assessment";
import { createProviderInvestigationService, type ProviderInvestigationResult } from "@/server/incidents/provider-investigation-service";
import { createProviderEvidenceService, IncidentNotFoundError } from "@/server/incidents/provider-evidence-service";
import { createIncidentInvestigationRepository, type IncidentInvestigationRecord, type InvestigationStage } from "@/server/incidents/incident-investigation-repository";
import { createReceiverInvestigationService, ReceiverInvestigationConfigurationError, type ReceiverInvestigationResult } from "@/server/receiver/receiver-investigation-service";
import { createIncidentService } from "@/server/incidents/incident-service";
import { createIncidentWorkflowEventService } from "@/server/incidents/incident-workflow-event-service";
import { getConfiguredDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { getServerConfig } from "@/server/infrastructure/config";
import { createConfiguredTrueForgeClient, TrueForgeTurnCreateError, TrueForgeTurnInProgressError, type TrueForgeIncidentClient } from "@/server/trueforge/trueforge-client";
import { TrueForgeSessionMismatchError } from "@/server/trueforge/trueforge-session-service";

const CREATION_LEASE_MS = 60_000;

export interface IncidentInvestigationResult extends ProviderInvestigationResult {
  receiverObservation: { id: string; turnId: string; receiverInvestigatorThreadId: string; deliveryGuid: string; mutationCount: number; businessState: "ABSENT" | "EXACTLY_ONE" | "MULTIPLE"; observedAt: string };
  contradiction: RecoveryAssessment["contradiction"];
  recoveryState: RecoveryAssessment["recoveryState"];
}

export class IncidentInvestigationInProgressError extends TrueForgeTurnInProgressError {
  constructor(incidentId: string) {
    super(`Investigation for incident ${incidentId} is already running or awaiting remote reconciliation.`);
    this.name = "IncidentInvestigationInProgressError";
  }
}

export class IncidentInvestigationRetryableError extends Error {
  constructor(incidentId: string) {
    super(`TrueForge did not retain the reserved investigation turn for incident ${incidentId}. Retry to start a new serialized attempt.`);
    this.name = "IncidentInvestigationRetryableError";
  }
}

function receiverProductState(result: ReceiverInvestigationResult): IncidentInvestigationResult["receiverObservation"] {
  const observation = result.observation;
  return { id: observation.id, turnId: observation.turnId, receiverInvestigatorThreadId: observation.receiverInvestigatorThreadId, deliveryGuid: observation.deliveryGuid, mutationCount: observation.mutationCount, businessState: observation.businessState, observedAt: observation.observedAt };
}

function withMarker(input: TrueForgeApi.TurnInputItem[], marker: string): TrueForgeApi.TurnInputItem[] {
  return [...input, { type: "user.message", content: `Redrive durable investigation operation marker: ${marker}. This marker is for remote-operation reconciliation; do not act on it.` }];
}

function hasMarker(input: TrueForgeApi.TurnInputItem[] | undefined, marker: string): boolean {
  return input?.some((item) => item.type === "user.message" && typeof item.content === "string" && item.content.includes(`Redrive durable investigation operation marker: ${marker}.`)) ?? false;
}

async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of stream) values.push(value);
  return values;
}

type TurnTerminalState = "RUNNING" | "SUCCEEDED" | "FAILED";

function terminalState(events: readonly unknown[]): TurnTerminalState {
  const terminal = events.find((event) =>
    event !== null && typeof event === "object" &&
    (event as { type?: unknown }).type === "turn.done",
  ) as { state?: { status?: unknown } } | undefined;
  if (terminal === undefined) return "RUNNING";
  return terminal.state?.status === "done" ? "SUCCEEDED" : "FAILED";
}

function replayReservedTurn(
  values: readonly TrueForgeApi.TurnStreamingEvent[],
  repository: ReturnType<typeof createIncidentInvestigationRepository>,
  incidentId: string,
  stage: InvestigationStage,
  marker: string,
): AsyncIterable<TrueForgeApi.TurnStreamingEvent> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of values) {
        if (
          event !== null && typeof event === "object" &&
          (event as { type?: unknown }).type === "turn.created" &&
          typeof (event as { turnId?: unknown }).turnId === "string"
        ) {
          repository.markTurnCreated(incidentId, stage, marker, (event as { turnId: string }).turnId);
        }
        yield event;
      }
    },
  };
}

/** Writes the remote turn identity before handing its event to the investigator. */
function reservedClient(
  client: TrueForgeIncidentClient,
  repository: ReturnType<typeof createIncidentInvestigationRepository>,
  incidentId: string,
  stage: InvestigationStage,
  marker: string,
  existingTurnId?: string,
): TrueForgeIncidentClient {
  let replayTurnId = existingTurnId;
  let replayedExistingTurn = false;
  let latestCreatedTurnId: string | undefined;
  return {
    ...client,
    async createTurnStream(sessionId, request) {
      if (replayTurnId !== undefined && !replayedExistingTurn) {
        if (!repository.claimTurnReplay(incidentId, stage, marker, replayTurnId)) {
          throw new IncidentInvestigationInProgressError(incidentId);
        }
        const events = await collect(await client.listTurnEvents(sessionId, replayTurnId));
        const state = terminalState(events);
        if (state === "RUNNING") throw new IncidentInvestigationInProgressError(incidentId);
        if (state === "FAILED") throw new IncidentInvestigationRetryableError(incidentId);
        replayedExistingTurn = true;
        return replayReservedTurn(events as TrueForgeApi.TurnStreamingEvent[], repository, incidentId, stage, marker);
      }
      if (latestCreatedTurnId !== undefined) {
        if (!repository.prepareNextTurn(incidentId, stage, marker, latestCreatedTurnId)) {
          throw new IncidentInvestigationInProgressError(incidentId);
        }
        latestCreatedTurnId = undefined;
      } else if (replayedExistingTurn && replayTurnId !== undefined) {
        if (!repository.prepareNextTurn(incidentId, stage, marker, replayTurnId)) {
          throw new IncidentInvestigationInProgressError(incidentId);
        }
        replayTurnId = undefined;
      }
      let stream: AsyncIterable<TrueForgeApi.TurnStreamingEvent>;
      if (!repository.renewCreationLease(incidentId, stage, marker)) {
        throw new IncidentInvestigationInProgressError(incidentId);
      }
      try {
        stream = await client.createTurnStream(sessionId, { ...request, input: withMarker(request.input ?? [], marker) });
      } catch (error) {
        if (error instanceof TrueForgeTurnCreateError && error.kind === "DEFINITIVE") {
          repository.markRetryableFailure(incidentId, stage, marker, error);
          throw error;
        }
        repository.markUncertainAfterCreateAttempt(incidentId, stage, marker);
        throw new IncidentInvestigationInProgressError(incidentId);
      }
      return {
        async *[Symbol.asyncIterator]() {
          for await (const event of stream) {
            if (event !== null && typeof event === "object" && (event as { type?: unknown }).type === "turn.created" && typeof (event as { turnId?: unknown }).turnId === "string") {
              const turnId = (event as { turnId: string }).turnId;
              repository.markTurnCreated(incidentId, stage, marker, turnId);
              latestCreatedTurnId = turnId;
            }
            yield event;
          }
        },
      };
    },
  };
}

export function createIncidentInvestigationService(
  database: SqliteDatabase,
  trueForgeClient: TrueForgeIncidentClient,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
) {
  const incidentService = createIncidentService(database);
  const evidenceService = createProviderEvidenceService(database, now);
  const repository = createIncidentInvestigationRepository(database, now);
  const workflowEvents = createIncidentWorkflowEventService(database, now);
  const services = (client: TrueForgeIncidentClient) => ({
    provider: createProviderInvestigationService(database, client, environment, now),
    receiver: createReceiverInvestigationService(database, client, environment, now),
  });
  const sessionIdFor = (incidentId: string): string | null => {
    const row = database.get<{ sessionId: unknown }>("SELECT trueforge_session_id AS sessionId FROM trueforge_session_bindings WHERE incident_id = ? AND state = 'ACTIVE'", [incidentId]);
    return typeof row?.sessionId === "string" ? row.sessionId : null;
  };
  const staleBefore = (): string => {
    const timestamp = Date.parse(now());
    if (!Number.isFinite(timestamp)) throw new Error("Investigation clock returned an invalid timestamp.");
    return new Date(timestamp - CREATION_LEASE_MS).toISOString();
  };

  async function hasKnownNonterminalTurn(
    incidentId: string,
    stage: InvestigationStage,
  ): Promise<boolean> {
    const record = repository.get(incidentId);
    const turnId = stage === "PROVIDER" ? record?.providerTurnId : record?.receiverTurnId;
    if (record?.state !== `${stage}_RUNNING` || turnId === null || turnId === undefined) return false;
    const sessionId = sessionIdFor(incidentId);
    if (sessionId === null) return true;
    try {
      return terminalState(await collect(await trueForgeClient.listTurnEvents(sessionId, turnId))) === "RUNNING";
    } catch {
      // A failed read cannot establish terminal remote failure.
      return true;
    }
  }

  function persisted(incidentId: string): IncidentInvestigationResult | null {
    const evidence = evidenceService.getByIncidentId(incidentId);
    const provider = persistedProviderResult(incidentId);
    const record = repository.get(incidentId);
    const observations = services(trueForgeClient).receiver.getObservations(incidentId);
    const observation = record?.receiverTurnId === null || record?.receiverTurnId === undefined
      ? observations.at(-1)
      : observations.find((candidate) => candidate.turnId === record.receiverTurnId);
    if (
      evidence === null || provider === null || observation === undefined
    ) return null;
    return {
      ...provider,
      receiverObservation: { id: observation.id, turnId: observation.turnId, receiverInvestigatorThreadId: observation.receiverInvestigatorThreadId, deliveryGuid: observation.deliveryGuid, mutationCount: observation.mutationCount, businessState: observation.businessState, observedAt: observation.observedAt },
      ...deriveRecoveryAssessment(evidence, observation),
    };
  }

  function persistedProviderResult(incidentId: string): ProviderInvestigationResult | null {
    const evidence = evidenceService.getByIncidentId(incidentId);
    const event = workflowEvents.listByIncidentId(incidentId)
      .filter((candidate) => candidate.eventType === "PROVIDER_EVIDENCE_CAPTURED" || candidate.eventType === "PROVIDER_EVIDENCE_REOBSERVED")
      .at(-1) ?? null;
    if (
      evidence === null || event === null || event.trueForgeSessionId === null ||
      event.turnId === null || event.providerInvestigatorThreadId === null
    ) return null;
    return {
      incidentId,
      trueForgeSessionId: event.trueForgeSessionId,
      turnId: event.turnId,
      providerInvestigatorThreadId: event.providerInvestigatorThreadId,
      evidenceDisposition: event.eventType === "PROVIDER_EVIDENCE_CAPTURED" ? "CAPTURED" : "REOBSERVED",
      providerStatus: evidence.outcome.status,
      providerStatusCode: evidence.outcome.statusCode,
    };
  }

  async function reconcileUncertain(incidentId: string, record: IncidentInvestigationRecord): Promise<IncidentInvestigationRecord> {
    const stage: InvestigationStage = record.state.startsWith("PROVIDER") ? "PROVIDER" : "RECEIVER";
    const marker = stage === "PROVIDER" ? record.providerOperationToken : record.receiverOperationToken;
    const sessionId = sessionIdFor(incidentId);
    if (marker === null || sessionId === null || trueForgeClient.listTurns === undefined) throw new IncidentInvestigationInProgressError(incidentId);
    const found = (await trueForgeClient.listTurns(sessionId)).find((turn) => hasMarker(turn.input, marker));
    if (found === undefined) {
      repository.markReconciledAbsent(incidentId, stage);
      throw new IncidentInvestigationRetryableError(incidentId);
    }
    repository.markTurnCreated(incidentId, stage, marker, found.id);
    return repository.get(incidentId)!;
  }

  async function investigate(incidentId: string): Promise<IncidentInvestigationResult> {
    const incident = incidentService.getById(incidentId);
    if (incident === null) throw new IncidentNotFoundError(incidentId);
    const initialPersisted = persisted(incidentId);
    if (initialPersisted !== null) {
      repository.reserve(incidentId, true, true);
      repository.backfillCompletedProvenance(
        incidentId,
        initialPersisted.turnId,
        initialPersisted.receiverObservation.turnId,
      );
      return initialPersisted;
    }

    const existingEvidence = evidenceService.getByIncidentId(incidentId);
    const existingObservation = services(trueForgeClient).receiver.getObservations(incidentId).at(-1);
    const reservation = repository.reserve(incidentId, existingEvidence !== null, existingObservation !== undefined);
    let record = reservation.record;
    if (record.state === "COMPLETED") throw new Error("Completed investigation is missing authoritative evidence.");
    // A previous process may have died between reserving and observing the
    // POST response. Treat that durable reservation as ambiguous, never as a
    // license to create another remote turn.
    if (!reservation.acquired && record.state.endsWith("CREATING")) {
      const stage = record.state.startsWith("PROVIDER") ? "PROVIDER" : "RECEIVER";
      const operationToken = stage === "PROVIDER" ? record.providerOperationToken : record.receiverOperationToken;
      if (operationToken === null || !repository.markUncertainIfStale(incidentId, stage, operationToken, record.updatedAt, staleBefore())) {
        throw new IncidentInvestigationInProgressError(incidentId);
      }
      record = repository.get(incidentId)!;
    }
    if (record.state.endsWith("UNCERTAIN")) record = await reconcileUncertain(incidentId, record);

    for (const [stage, turnId] of [["PROVIDER", record.providerTurnId], ["RECEIVER", record.receiverTurnId]] as const) {
      if (record.state === `${stage}_RUNNING`) {
        const sessionId = sessionIdFor(incidentId);
        if (sessionId === null || turnId === null) throw new IncidentInvestigationInProgressError(incidentId);
        const state = terminalState(await collect(await trueForgeClient.listTurnEvents(sessionId, turnId)));
        if (state === "RUNNING") throw new IncidentInvestigationInProgressError(incidentId);
        if (state === "FAILED") {
          const operationToken = stage === "PROVIDER" ? record.providerOperationToken : record.receiverOperationToken;
          if (operationToken !== null) {
            repository.markRetryableFailure(incidentId, stage, operationToken, new Error("TrueForge turn terminated without successful completion."));
          }
          throw new IncidentInvestigationRetryableError(incidentId);
        }
      }
    }

    let provider: ProviderInvestigationResult;
    try {
      if (existingEvidence === null) {
        if (record.providerOperationToken === null) throw new Error("Provider investigation reservation is missing its marker.");
        provider = await services(reservedClient(trueForgeClient, repository, incidentId, "PROVIDER", record.providerOperationToken, record.state === "PROVIDER_RUNNING" ? record.providerTurnId ?? undefined : undefined)).provider.investigateProviderForIncident(incidentId);
        record = repository.markProviderCaptured(incidentId, record.providerOperationToken!);
      } else {
        if (record.state.startsWith("PROVIDER")) {
          record = repository.markProviderCaptured(incidentId, record.providerOperationToken!);
        }
        const persistedProvider = persistedProviderResult(incidentId);
        if (persistedProvider === null) throw new IncidentInvestigationInProgressError(incidentId);
        provider = persistedProvider;
      }
    } catch (error) {
      if (error instanceof IncidentInvestigationInProgressError) throw error;
      if (await hasKnownNonterminalTurn(incidentId, "PROVIDER")) {
        throw new IncidentInvestigationInProgressError(incidentId);
      }
      const operationToken = record.providerOperationToken;
      if (operationToken !== null) repository.markRetryableFailure(incidentId, "PROVIDER", operationToken, error);
      throw error;
    }

    const evidence = evidenceService.getByIncidentId(incidentId);
    if (evidence === null) throw new ReceiverInvestigationConfigurationError("Accepted provider evidence is required before receiver investigation.");
    const connectionId = incident.applicationConnectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0) throw new ReceiverInvestigationConfigurationError("A durable application connection is required before receiver investigation.");
    if (record.state !== "RECEIVER_CREATING" && record.state !== "RECEIVER_RUNNING") throw new IncidentInvestigationInProgressError(incidentId);
    try {
      if (record.receiverOperationToken === null) throw new Error("Receiver investigation reservation is missing its marker.");
      const receiver = await services(reservedClient(trueForgeClient, repository, incidentId, "RECEIVER", record.receiverOperationToken, record.state === "RECEIVER_RUNNING" ? record.receiverTurnId ?? undefined : undefined)).receiver.investigateReceiverForIncident(incidentId, { connectionId, deliveryGuid: evidence.deliveryGuid, expectedSessionId: provider.trueForgeSessionId });
      if (receiver.trueForgeSessionId !== provider.trueForgeSessionId) throw new TrueForgeSessionMismatchError(incidentId);
      repository.markCompleted(incidentId, record.receiverOperationToken!);
      return { ...provider, receiverObservation: receiverProductState(receiver), ...deriveRecoveryAssessment(evidence, receiver.observation) };
    } catch (error) {
      if (error instanceof IncidentInvestigationInProgressError) throw error;
      if (await hasKnownNonterminalTurn(incidentId, "RECEIVER")) {
        throw new IncidentInvestigationInProgressError(incidentId);
      }
      const operationToken = record.receiverOperationToken;
      if (operationToken !== null) repository.markRetryableFailure(incidentId, "RECEIVER", operationToken, error);
      throw error;
    }
  }

  const base = services(trueForgeClient);
  return { investigateProviderAndReceiverForIncident: investigate, getProviderWorkflowEvents: base.provider.getWorkflowEvents, getReceiverObservations: base.receiver.getObservations };
}

type IncidentInvestigationService = ReturnType<typeof createIncidentInvestigationService>;

function withConfiguredService<T>(operation: (service: IncidentInvestigationService) => T): T {
  const database: SqliteDatabase = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(createIncidentInvestigationService(database, createConfiguredTrueForgeClient()));
}

export async function investigateIncidentForRecovery(incidentId: string): Promise<IncidentInvestigationResult> {
  return withConfiguredService((service) => service.investigateProviderAndReceiverForIncident(incidentId));
}
