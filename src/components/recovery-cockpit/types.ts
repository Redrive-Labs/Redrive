export type SpineStatus =
  | "PENDING"
  | "ACTIVE"
  | "VERIFIED"
  | "WAITING_APPROVAL"
  | "LOCKED"
  | "FAILED"
  | "OUTCOME_UNKNOWN"
  | "COMPLETE";

export type RecoveryContradiction =
  | "PROVIDER_FAILED_RECEIVER_MUTATED"
  | null;

export type ReceiverBusinessState = "ABSENT" | "EXACTLY_ONE" | "MULTIPLE";

export type RecoveryCockpitViewModel = {
  incident: {
    id: string;
    repository: string;
    deliveryId: string;
    deliveryGuid?: string;
    event?: string;
    createdAt?: string;
    status: string;
  };

  provider?: {
    statusCode: number;
    status: string;
    observed: boolean;
    observedAt?: string;
    provenance?: EvidenceProvenance;
  };

  receiver?: {
    mutationCount: number;
    businessState: ReceiverBusinessState;
    observed: boolean;
    observedAt?: string;
    provenance?: EvidenceProvenance;
  };

  assessment?: {
    contradiction: RecoveryContradiction;
    recoveryState: "BLOCKED" | "ELIGIBLE" | "COMPLETE";
  };

  sandbox?: {
    state:
      | "NOT_STARTED"
      | "RUNNING"
      | "REPAIR_VERIFIED"
      | "FAILED"
      | "OUTCOME_UNKNOWN";
    originalRevision?: string;
    reproduction?: SandboxProof;
    verification?: SandboxProof;
    patchSha256?: string;
    changedFiles?: string[];
    failureReason?: string;
    provenance?: SandboxProvenance;
  };

  deployment?: {
    state:
      | "NOT_READY"
      | "AWAITING_APPROVAL"
      | "APPROVED"
      | "DEPLOYING"
      | "VERIFIED"
      | "FAILED"
      | "OUTCOME_UNKNOWN";
    fingerprint?: string;
    patchSha256?: string;
    deploymentTarget?: string;
    approvedAt?: string;
    permitId?: string;
    permitState?: "APPROVED" | "CONSUMED" | "REVOKED";
    reason?: string;
    healthStatusCode?: number;
    mutationCount?: number;
    failure?: DeploymentFailure;
  };

  redrive?: {
    state:
      | "NOT_READY"
      | "AWAITING_APPROVAL"
      | "APPROVED"
      | "DISPATCHING"
      | "VERIFYING"
      | "COMPLETE"
      | "BLOCKED"
      | "OUTCOME_UNKNOWN";
    fingerprint?: string;
    providerStatusCode?: number;
    finalMutationCount?: number;
    approvedAt?: string;
    permitId?: string;
    permitState?: "APPROVED" | "CONSUMED" | "REVOKED";
    reason?: string;
  };

  receipt?: {
    id?: string;
    createdAt?: string;
    patchSha256?: string;
    outcome: "RECOVERY_COMPLETE";
    originalProviderStatusCode: number;
    originalReceiverMutationCount: number;
    sandboxRetryStatusCode: number;
    sandboxRetryMutationCount: number;
    deploymentHealthStatusCode: number;
    redeliveryProviderStatusCode: number;
    finalReceiverMutationCount: number;
    finalReceiverBusinessState: "EXACTLY_ONE";
  };

  provenance?: {
    investigation?: {
      trueForgeSessionId?: string;
      providerInvestigator?: string;
      receiverInvestigator?: string;
      turnId?: string;
    };
    recovery?: {
      trueForgeSessionId?: string;
      turnId?: string;
      sandboxId?: string;
    };
    humanControl?: {
      deployPermitId?: string;
      redrivePermitId?: string;
    };
  };
};

export type SandboxProof = {
  preCount: number;
  httpStatus: number;
  postCount: number;
};

export type EvidenceProvenance = {
  trueForgeSessionId?: string;
  turnId?: string;
  investigator?: string;
  toolName?: string;
  deliveryGuid?: string;
};

export type SandboxProvenance = {
  trueForgeSessionId?: string;
  turnId?: string;
  sandboxId?: string;
};

export type DeploymentFailure = {
  expectedMutationCount: number;
  observedMutationCount: number;
};

export type RecoveryAction = () => Promise<void>;

