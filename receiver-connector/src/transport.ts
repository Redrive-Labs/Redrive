import {
  RECEIVER_CAPABILITIES,
  type CapabilityError,
  type CapabilityInput,
  type CapabilityJob,
  type CapabilityResult,
  type ConnectorIdentity,
  type JobFailureReference,
  type ReceiverCapability,
} from "./model.js";
import { TransportError } from "./errors.js";

export interface EnrollmentRequest {
  readonly identity: ConnectorIdentity;
  readonly enrollmentToken: string;
  readonly capabilities: typeof RECEIVER_CAPABILITIES;
}

export interface EnrollmentResult {
  readonly connectorId?: string;
}

export interface LeaseRequest {
  readonly identity: ConnectorIdentity;
  readonly capabilities: typeof RECEIVER_CAPABILITIES;
}

export interface CompleteRequest {
  readonly identity: ConnectorIdentity;
  readonly jobId: string;
  readonly capability: ReceiverCapability;
  readonly input: CapabilityInput;
  readonly leaseGeneration: number;
  readonly result: CapabilityResult;
}

export interface FailRequest {
  readonly identity: ConnectorIdentity;
  readonly jobId: string;
  readonly capability: string;
  readonly leaseGeneration: number;
  readonly error: CapabilityError;
}

export interface RedriveTransport {
  enroll(request: EnrollmentRequest): Promise<EnrollmentResult>;
  lease(request: LeaseRequest): Promise<CapabilityJob | null>;
  complete(request: CompleteRequest): Promise<void>;
  fail(request: FailRequest): Promise<void>;
}

export const CENTRAL_TRANSPORT_INTEGRATION_PENDING_MESSAGE =
  "Central HTTP transport integration is pending; no Redrive routes are configured in this connector runtime.";

export function createPendingRedriveTransport(): RedriveTransport {
  const pending = async (): Promise<never> => {
    throw new TransportError(
      "TRANSPORT_INTEGRATION_PENDING",
      CENTRAL_TRANSPORT_INTEGRATION_PENDING_MESSAGE,
      false,
    );
  };
  return {
    enroll: pending,
    lease: pending,
    complete: pending,
    fail: pending,
  };
}

export function asJobFailureReference(
  job: CapabilityJob,
): JobFailureReference {
  return {
    jobId: job.jobId,
    capability: job.capability,
    leaseGeneration: job.leaseGeneration,
  };
}
