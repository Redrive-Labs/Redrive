import { createHash } from "node:crypto";

export const REDRIVE_FINGERPRINT_SCHEMA_VERSION = 1 as const;
export const REDRIVE_FINGERPRINT_KIND = "REDRIVE" as const;
export const REDRIVE_DEPLOYMENT_TARGET = "demo-receiver-local" as const;

export type RedrivePermitState = "APPROVED" | "CONSUMED" | "REVOKED";
export type RedriveDispatchState =
  | "PREPARED"
  | "DISPATCHING"
  | "DISPATCHED"
  | "PROVIDER_VERIFIED"
  | "COMPLETE"
  | "FAILED"
  | "OUTCOME_UNKNOWN";

export interface RedriveFingerprintInput {
  /** Optional on the function input; the serializer always supplies these. */
  schemaVersion?: typeof REDRIVE_FINGERPRINT_SCHEMA_VERSION;
  kind?: typeof REDRIVE_FINGERPRINT_KIND;
  incidentId: string;
  recoveryAttemptId: string;
  deploymentId: string;
  applicationConnectionId: string;
  providerDeliveryId: string;
  deliveryGuid: string;
  patchSha256: string;
  deploymentTarget: typeof REDRIVE_DEPLOYMENT_TARGET;
  preRedriveMutationCount: 1;
}

export interface RedriveFingerprintObject extends Omit<RedriveFingerprintInput, "schemaVersion" | "kind"> {
  schemaVersion: typeof REDRIVE_FINGERPRINT_SCHEMA_VERSION;
  kind: typeof REDRIVE_FINGERPRINT_KIND;
}

/** Serialize the permit identity in the contract's fixed field order. */
export function serializeRedriveFingerprint(
  input: RedriveFingerprintInput,
): string {
  const fingerprint: RedriveFingerprintObject = {
    schemaVersion: REDRIVE_FINGERPRINT_SCHEMA_VERSION,
    kind: REDRIVE_FINGERPRINT_KIND,
    incidentId: input.incidentId,
    recoveryAttemptId: input.recoveryAttemptId,
    deploymentId: input.deploymentId,
    applicationConnectionId: input.applicationConnectionId,
    providerDeliveryId: input.providerDeliveryId,
    deliveryGuid: input.deliveryGuid,
    patchSha256: input.patchSha256,
    deploymentTarget: input.deploymentTarget,
    preRedriveMutationCount: input.preRedriveMutationCount,
  };
  return JSON.stringify(fingerprint);
}

export function computeRedriveFingerprintSha256(
  input: RedriveFingerprintInput,
): string {
  return createHash("sha256")
    .update(serializeRedriveFingerprint(input), "utf8")
    .digest("hex");
}
