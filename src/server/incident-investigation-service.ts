import {
  deriveRecoveryAssessment,
  type RecoveryAssessment,
} from "@/domain/recovery-assessment";
import {
  createProviderInvestigationService,
  type ProviderInvestigationResult,
} from "@/server/provider-investigation-service";
import {
  createProviderEvidenceService,
  IncidentNotFoundError,
} from "@/server/provider-evidence-service";
import {
  createReceiverInvestigationService,
  ReceiverInvestigationConfigurationError,
  type ReceiverInvestigationResult,
} from "@/server/receiver-investigation-service";
import { createIncidentService } from "@/server/incident-service";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { getServerConfig } from "@/server/config";
import {
  createConfiguredTrueForgeClient,
  type TrueForgeIncidentClient,
} from "@/server/trueforge-client";
import { TrueForgeSessionMismatchError } from "@/server/trueforge-session-service";

export interface IncidentInvestigationResult extends ProviderInvestigationResult {
  receiverObservation: {
    id: string;
    turnId: string;
    receiverInvestigatorThreadId: string;
    deliveryGuid: string;
    mutationCount: number;
    businessState: "ABSENT" | "EXACTLY_ONE" | "MULTIPLE";
    observedAt: string;
  };
  contradiction: RecoveryAssessment["contradiction"];
  recoveryState: RecoveryAssessment["recoveryState"];
}

function receiverObservationProductState(
  result: ReceiverInvestigationResult,
): IncidentInvestigationResult["receiverObservation"] {
  return {
    id: result.observation.id,
    turnId: result.observation.turnId,
    receiverInvestigatorThreadId: result.observation.receiverInvestigatorThreadId,
    deliveryGuid: result.observation.deliveryGuid,
    mutationCount: result.observation.mutationCount,
    businessState: result.observation.businessState,
    observedAt: result.observation.observedAt,
  };
}

export function createIncidentInvestigationService(
  database: SqliteDatabase,
  trueForgeClient: TrueForgeIncidentClient,
  environment: NodeJS.ProcessEnv = process.env,
  now: () => string = () => new Date().toISOString(),
) {
  const incidentService = createIncidentService(database);
  const providerService = createProviderInvestigationService(
    database,
    trueForgeClient,
    environment,
    now,
  );
  const receiverService = createReceiverInvestigationService(
    database,
    trueForgeClient,
    environment,
    now,
  );
  const providerEvidenceService = createProviderEvidenceService(database, now);

  async function investigate(
    incidentId: string,
  ): Promise<IncidentInvestigationResult> {
    const provider = await providerService.investigateProviderForIncident(
      incidentId,
    );
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new IncidentNotFoundError(incidentId);
    }
    const providerEvidence = providerEvidenceService.getByIncidentId(incidentId);
    if (providerEvidence === null) {
      throw new ReceiverInvestigationConfigurationError(
        "Accepted provider evidence is required before receiver investigation.",
      );
    }
    const connectionId = incident.applicationConnectionId;
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new ReceiverInvestigationConfigurationError(
        "A durable application connection is required before receiver investigation.",
      );
    }

    const receiver = await receiverService.investigateReceiverForIncident(
      incidentId,
      {
        connectionId,
        deliveryGuid: providerEvidence.deliveryGuid,
        expectedSessionId: provider.trueForgeSessionId,
      },
    );
    if (receiver.trueForgeSessionId !== provider.trueForgeSessionId) {
      throw new TrueForgeSessionMismatchError(incidentId);
    }

    const assessment = deriveRecoveryAssessment(
      providerEvidence,
      receiver.observation,
    );
    return {
      ...provider,
      receiverObservation: receiverObservationProductState(receiver),
      ...assessment,
    };
  }

  return {
    investigateProviderAndReceiverForIncident: investigate,
    getProviderWorkflowEvents: providerService.getWorkflowEvents,
    getReceiverObservations: receiverService.getObservations,
  };
}

type IncidentInvestigationService = ReturnType<
  typeof createIncidentInvestigationService
>;

function withConfiguredService<T>(
  operation: (service: IncidentInvestigationService) => T,
): T {
  const database: SqliteDatabase = getConfiguredDatabase(
    getServerConfig().databasePath,
  );
  return operation(
    createIncidentInvestigationService(
      database,
      createConfiguredTrueForgeClient(),
    ),
  );
}

export async function investigateIncidentForRecovery(
  incidentId: string,
): Promise<IncidentInvestigationResult> {
  return withConfiguredService((service) =>
    service.investigateProviderAndReceiverForIncident(incidentId),
  );
}
