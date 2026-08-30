import type { ProviderEvidence } from "@/domain/provider-evidence";
import type { ReceiverObservation } from "@/domain/receiver-observation";

export const RECOVERY_STATE_BLOCKED = "BLOCKED" as const;
export const PROVIDER_FAILED_RECEIVER_MUTATED =
  "PROVIDER_FAILED_RECEIVER_MUTATED" as const;

export type RecoveryContradiction =
  | typeof PROVIDER_FAILED_RECEIVER_MUTATED
  | null;

export interface RecoveryAssessment {
  contradiction: RecoveryContradiction;
  recoveryState: typeof RECOVERY_STATE_BLOCKED;
}

export class RecoveryAssessmentCorrelationError extends Error {
  constructor(message: string) {
    super(`Recovery assessment evidence correlation failed: ${message}`);
    this.name = "RecoveryAssessmentCorrelationError";
  }
}

function requireCorrelatedEvidence(
  providerEvidence: ProviderEvidence,
  receiverObservation: ReceiverObservation,
): void {
  if (
    typeof providerEvidence.incidentId !== "string" ||
    providerEvidence.incidentId.length === 0 ||
    providerEvidence.incidentId !== receiverObservation.incidentId
  ) {
    throw new RecoveryAssessmentCorrelationError(
      "provider and receiver evidence do not belong to the same incident.",
    );
  }
  if (
    typeof providerEvidence.applicationConnectionId !== "string" ||
    providerEvidence.applicationConnectionId.length === 0 ||
    providerEvidence.applicationConnectionId !==
      receiverObservation.applicationConnectionId
  ) {
    throw new RecoveryAssessmentCorrelationError(
      "provider and receiver evidence do not belong to the same application connection.",
    );
  }
  if (providerEvidence.deliveryGuid !== receiverObservation.deliveryGuid) {
    throw new RecoveryAssessmentCorrelationError(
      "provider and receiver evidence do not belong to the same delivery GUID.",
    );
  }
}

/**
 * M2.7B deliberately keeps every assessment blocked. A contradiction is only
 * authoritative when both independent machine observations match the exact
 * canonical rule; receiver absence is not evidence that replay is safe.
 */
export function deriveRecoveryAssessment(
  providerEvidence: ProviderEvidence | null,
  receiverObservation: ReceiverObservation | null,
): RecoveryAssessment {
  if (providerEvidence !== null && receiverObservation !== null) {
    requireCorrelatedEvidence(providerEvidence, receiverObservation);
  }

  const contradiction =
    providerEvidence?.outcome.statusCode === 500 &&
    receiverObservation?.mutationCount === 1 &&
    receiverObservation?.businessState === "EXACTLY_ONE"
      ? PROVIDER_FAILED_RECEIVER_MUTATED
      : null;

  return {
    contradiction,
    recoveryState: RECOVERY_STATE_BLOCKED,
  };
}
