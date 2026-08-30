import type { Incident } from "@/domain/incident";
import { deriveRecoveryAssessment } from "@/domain/recovery-assessment";
import { parseRecoveryResultJson } from "@/domain/recovery-result";
import type { RecoveryCockpitViewModel } from "@/components/recovery-cockpit/types";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createIncidentWorkflowEventService } from "@/server/incident-workflow-event-service";
import { createProviderEvidenceService } from "@/server/provider-evidence-service";
import { createReceiverObservationService } from "@/server/receiver-observation-service";
import { createRecoveryAttemptRepository } from "@/server/recovery-attempt-repository";
import { getDeploymentStatusForIncident } from "@/server/recovery-deployment-service";
import { createConfiguredRedriveService } from "@/server/redrive-service";
import { createTrueForgeSessionBindingRepository } from "@/server/trueforge-session-binding-repository";

function sandboxState(attempt: ReturnType<ReturnType<typeof createRecoveryAttemptRepository>["getByIncidentId"]>): NonNullable<RecoveryCockpitViewModel["sandbox"]>["state"] {
  if (attempt === null) return "NOT_STARTED";
  if (attempt.state === "REPAIR_VERIFIED") return "REPAIR_VERIFIED";
  if (attempt.state === "FAILED") return "FAILED";
  if (attempt.state === "SESSION_UNCERTAIN" || attempt.state === "SESSION_LOST") return "OUTCOME_UNKNOWN";
  return "RUNNING";
}

function proof(preCount: number | null, httpStatus: number | null, postCount: number | null) {
  return preCount === null || httpStatus === null || postCount === null
    ? undefined
    : { preCount, httpStatus, postCount };
}

function deploymentState(status: ReturnType<typeof getDeploymentStatusForIncident>): NonNullable<RecoveryCockpitViewModel["deployment"]>["state"] {
  if (status.deployment?.state === "VERIFIED") return "VERIFIED";
  if (status.deployment?.state === "FAILED") return "FAILED";
  if (status.deployment?.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (status.deployment) return "DEPLOYING";
  if (status.permit?.state === "APPROVED") return "APPROVED";
  if (status.candidate && status.eligible) return "AWAITING_APPROVAL";
  return "NOT_READY";
}

function redriveState(state: Awaited<ReturnType<ReturnType<typeof createConfiguredRedriveService>["getState"]>>): NonNullable<RecoveryCockpitViewModel["redrive"]>["state"] {
  if (state.receipt?.outcome === "RECOVERY_COMPLETE" || state.dispatch?.state === "COMPLETE") return "COMPLETE";
  if (state.dispatch?.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (state.dispatch?.state === "FAILED") return "BLOCKED";
  if (state.dispatch?.state === "PROVIDER_VERIFIED") return "VERIFYING";
  if (state.dispatch) return "DISPATCHING";
  if (state.permit?.state === "APPROVED") return "APPROVED";
  if (state.candidate && state.eligibility.eligible && state.fingerprint) return "AWAITING_APPROVAL";
  return "NOT_READY";
}

export async function buildRecoveryCockpitViewModel(incident: Incident): Promise<RecoveryCockpitViewModel> {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  const provider = createProviderEvidenceService(database).getByIncidentId(incident.id);
  const receiver = createReceiverObservationService(database).listByIncidentId(incident.id).at(-1) ?? null;
  const attempt = createRecoveryAttemptRepository(database).getByIncidentId(incident.id);
  const binding = createTrueForgeSessionBindingRepository(database).getByIncidentId(incident.id);
  const workflowEvents = createIncidentWorkflowEventService(database).listByIncidentId(incident.id);
  const providerEvent = workflowEvents.findLast((event) => event.eventType === "PROVIDER_EVIDENCE_CAPTURED" || event.eventType === "PROVIDER_EVIDENCE_REOBSERVED");
  const assessment = provider && receiver ? deriveRecoveryAssessment(provider, receiver) : null;

  let changedFiles: string[] | undefined;
  if (attempt?.resultJson && attempt.state === "REPAIR_VERIFIED") {
    try {
      changedFiles = parseRecoveryResultJson(attempt.resultJson, {
        sourceRepositoryFullName: attempt.sourceRepositoryFullName,
        originalRevision: attempt.originalRevision,
        deliveryGuid: attempt.deliveryGuid,
        providerStatusCode: attempt.providerStatusCode,
        receiverMutationCount: attempt.receiverPreCount,
      }).changedFiles;
    } catch {
      changedFiles = undefined;
    }
  }

  let deploymentStatus: ReturnType<typeof getDeploymentStatusForIncident> | null = null;
  try {
    deploymentStatus = getDeploymentStatusForIncident(incident.id);
  } catch {
    deploymentStatus = null;
  }

  let redriveStatus: Awaited<ReturnType<ReturnType<typeof createConfiguredRedriveService>["getState"]>> | null = null;
  try {
    redriveStatus = await createConfiguredRedriveService().getState(incident.id);
  } catch {
    redriveStatus = null;
  }

  const model: RecoveryCockpitViewModel = {
    incident: {
      id: incident.id,
      repository: incident.repositoryId,
      deliveryId: incident.externalDeliveryId,
      ...(provider?.deliveryGuid ? { deliveryGuid: provider!.deliveryGuid } : {}),
      event: provider?.event ?? "GitHub webhook",
      createdAt: incident.createdAt,
      status: incident.status,
    },
    ...(provider?.outcome.statusCode !== null ? {
      provider: {
        statusCode: provider!.outcome.statusCode,
        status: provider!.outcome.status,
        observed: true,
        observedAt: provider!.capturedAt,
        provenance: {
          ...(providerEvent?.trueForgeSessionId ? { trueForgeSessionId: providerEvent.trueForgeSessionId } : {}),
          ...(providerEvent?.turnId ? { turnId: providerEvent.turnId } : {}),
          investigator: "Provider Investigator",
          toolName: "get_webhook_delivery",
          deliveryGuid: provider!.deliveryGuid,
        },
      },
    } : {}),
    ...(receiver ? {
      receiver: {
        mutationCount: receiver.mutationCount,
        businessState: receiver.businessState,
        observed: true,
        observedAt: receiver.observedAt,
        provenance: {
          trueForgeSessionId: receiver.trueForgeSessionId,
          turnId: receiver.turnId,
          investigator: "Receiver Investigator",
          toolName: receiver.tool,
          deliveryGuid: receiver.deliveryGuid,
        },
      },
    } : {}),
    ...(assessment ? { assessment } : {}),
    sandbox: {
      state: sandboxState(attempt),
      ...(attempt ? {
        originalRevision: attempt.originalRevision,
        ...(proof(attempt.reproductionPreCount, attempt.reproductionHttpStatus, attempt.reproductionPostCount) ? { reproduction: proof(attempt.reproductionPreCount, attempt.reproductionHttpStatus, attempt.reproductionPostCount) } : {}),
        ...(proof(attempt.verificationPreCount, attempt.verificationHttpStatus, attempt.verificationPostCount) ? { verification: proof(attempt.verificationPreCount, attempt.verificationHttpStatus, attempt.verificationPostCount) } : {}),
        ...(attempt.patchSha256 ? { patchSha256: attempt.patchSha256 } : {}),
        ...(changedFiles ? { changedFiles } : {}),
        ...(attempt.failureCode ? { failureReason: attempt.failureCode } : {}),
        provenance: {
          ...(attempt.trueForgeSessionId ? { trueForgeSessionId: attempt.trueForgeSessionId } : {}),
          ...(attempt.trueForgeTurnId ? { turnId: attempt.trueForgeTurnId } : {}),
        },
      } : {}),
    },
    provenance: {
      ...(binding?.trueForgeSessionId ? {
        investigation: {
          trueForgeSessionId: binding.trueForgeSessionId,
          providerInvestigator: "Provider Investigator",
          receiverInvestigator: "Receiver Investigator",
          ...(receiver?.turnId ? { turnId: receiver.turnId } : {}),
        },
      } : {}),
      ...(attempt?.trueForgeSessionId ? {
        recovery: {
          trueForgeSessionId: attempt.trueForgeSessionId,
          ...(attempt.trueForgeTurnId ? { turnId: attempt.trueForgeTurnId } : {}),
        },
      } : {}),
    },
  };

  if (deploymentStatus) {
    model.deployment = {
      state: deploymentState(deploymentStatus),
      ...(deploymentStatus.fingerprint ? { fingerprint: deploymentStatus.fingerprint } : {}),
      ...(deploymentStatus.candidate?.patchSha256 ? { patchSha256: deploymentStatus.candidate.patchSha256 } : {}),
      ...(deploymentStatus.candidate?.deploymentTarget ? { deploymentTarget: deploymentStatus.candidate.deploymentTarget } : {}),
      ...(deploymentStatus.permit ? {
        permitId: deploymentStatus.permit.id,
        permitState: deploymentStatus.permit.state,
        approvedAt: deploymentStatus.permit.approvedAt,
      } : {}),
      ...(deploymentStatus.deployment?.healthStatusCode !== null && deploymentStatus.deployment?.healthStatusCode !== undefined ? { healthStatusCode: deploymentStatus.deployment.healthStatusCode } : {}),
      ...(deploymentStatus.deployment?.postDeployMutationCount !== null && deploymentStatus.deployment?.postDeployMutationCount !== undefined ? { mutationCount: deploymentStatus.deployment.postDeployMutationCount } : {}),
      ...(deploymentStatus.reason ? { reason: deploymentStatus.reason } : {}),
    };
    if (deploymentStatus.permit) model.provenance!.humanControl = { deployPermitId: deploymentStatus.permit.id };
  }

  if (redriveStatus) {
    model.redrive = {
      state: redriveState(redriveStatus),
      ...(redriveStatus.fingerprint ? { fingerprint: redriveStatus.fingerprint } : {}),
      ...(redriveStatus.permit ? {
        permitId: redriveStatus.permit.id,
        permitState: redriveStatus.permit.state,
        approvedAt: redriveStatus.permit.approvedAt,
      } : {}),
      ...(redriveStatus.dispatch?.providerStatusCode !== null && redriveStatus.dispatch?.providerStatusCode !== undefined ? { providerStatusCode: redriveStatus.dispatch.providerStatusCode } : {}),
      ...(redriveStatus.dispatch?.finalMutationCount !== null && redriveStatus.dispatch?.finalMutationCount !== undefined ? { finalMutationCount: redriveStatus.dispatch.finalMutationCount } : {}),
      ...(!redriveStatus.eligibility.eligible && redriveStatus.eligibility.reason ? { reason: redriveStatus.eligibility.reason } : {}),
    };
    if (redriveStatus.permit) model.provenance!.humanControl = {
      ...model.provenance!.humanControl,
      redrivePermitId: redriveStatus.permit.id,
    };
    if (redriveStatus.receipt?.outcome === "RECOVERY_COMPLETE" && redriveStatus.receipt.finalReceiverBusinessState === "EXACTLY_ONE") {
      model.receipt = {
        id: redriveStatus.receipt.id,
        createdAt: redriveStatus.receipt.createdAt,
        patchSha256: redriveStatus.receipt.patchSha256,
        outcome: "RECOVERY_COMPLETE",
        originalProviderStatusCode: redriveStatus.receipt.originalProviderStatusCode,
        originalReceiverMutationCount: redriveStatus.receipt.originalReceiverMutationCount,
        sandboxRetryStatusCode: redriveStatus.receipt.sandboxRetryStatusCode,
        sandboxRetryMutationCount: redriveStatus.receipt.sandboxRetryMutationCount,
        deploymentHealthStatusCode: redriveStatus.receipt.deploymentHealthStatusCode,
        redeliveryProviderStatusCode: redriveStatus.receipt.redeliveryProviderStatusCode,
        finalReceiverMutationCount: redriveStatus.receipt.finalReceiverMutationCount,
        finalReceiverBusinessState: "EXACTLY_ONE",
      };
    }
  }

  return model;
}
