export const RECOVERY_ATTEMPT_STATES = [
  "SESSION_CREATING",
  "SESSION_UNCERTAIN",
  "READY",
  "RUNNING",
  "REPAIR_VERIFIED",
  "FAILED",
  "SESSION_LOST",
] as const;

export type RecoveryAttemptState = (typeof RECOVERY_ATTEMPT_STATES)[number];

export interface RecoveryAttempt {
  id: string;
  incidentId: string;
  state: RecoveryAttemptState;
  creationToken: string | null;
  trueForgeSessionId: string | null;
  recoverySpecVersion: string;
  sourceRepositoryFullName: string;
  originalRevision: string;
  providerStatusCode: number;
  receiverPreCount: number;
  deliveryGuid: string;
  trueForgeTurnId: string | null;
  resultJson: string | null;
  patchText: string | null;
  patchSha256: string | null;
  reproductionPreCount: number | null;
  reproductionHttpStatus: number | null;
  reproductionPostCount: number | null;
  verificationPreCount: number | null;
  verificationHttpStatus: number | null;
  verificationPostCount: number | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
  verifiedAt: string | null;
}
