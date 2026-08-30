import {
  ConfigurationError,
  ConnectorError,
  isRetryableTransportError,
  toCapabilityError,
} from "./errors.js";
import {
  loadOrCreateIdentity,
  markEnrollmentAcknowledged,
  type IdentityGenerator,
  type LoadedIdentity,
} from "./identity.js";
import {
  CapabilityValidationError,
  getJobFailureReference,
  parseCapabilityJob,
  parseCapabilityResult,
  RECEIVER_CAPABILITIES,
  type CapabilityJob,
  type CapabilityResult,
  type ConnectorIdentity,
  type JobFailureReference,
} from "./model.js";
import type {
  CompleteRequest,
  EnrollmentRequest,
  FailRequest,
  LeaseRequest,
  RedriveTransport,
} from "./transport.js";
import type { ConnectorConfig } from "./config.js";
import type { CapabilityDispatcher } from "./dispatcher.js";

export const DEFAULT_IDLE_DELAY_MS = 1_000 as const;
export const DEFAULT_TRANSPORT_FAILURE_DELAY_MS = 1_000 as const;

export interface RetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  initialDelayMs: 250,
  maxDelayMs: 2_000,
});

export interface ReceiverConnectorWorkerOptions {
  readonly config: ConnectorConfig;
  readonly transport: RedriveTransport;
  readonly dispatcher: CapabilityDispatcher;
  readonly identityGenerator?: IdentityGenerator;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly retryPolicy?: Partial<RetryPolicy>;
  readonly idleDelayMs?: number;
  readonly transportFailureDelayMs?: number;
}

export type WorkerIterationKind = "NO_WORK" | "COMPLETED" | "FAILED";

export interface WorkerIteration {
  readonly kind: WorkerIterationKind;
  readonly job?: CapabilityJob;
  readonly error?: ReturnType<typeof toCapabilityError>;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function validDelay(value: number | undefined, fallback: number): number {
  const delay = value ?? fallback;
  if (!Number.isSafeInteger(delay) || delay < 0 || delay > 120_000) {
    throw new ConfigurationError("The connector worker delay is invalid.");
  }
  return delay;
}

function normalizedRetryPolicy(policy: Partial<RetryPolicy> | undefined): RetryPolicy {
  const value = {
    ...DEFAULT_RETRY_POLICY,
    ...policy,
  };
  if (
    !Number.isSafeInteger(value.maxAttempts) ||
    value.maxAttempts < 1 ||
    value.maxAttempts > 10 ||
    !Number.isSafeInteger(value.initialDelayMs) ||
    value.initialDelayMs < 0 ||
    value.initialDelayMs > 120_000 ||
    !Number.isSafeInteger(value.maxDelayMs) ||
    value.maxDelayMs < value.initialDelayMs ||
    value.maxDelayMs > 120_000
  ) {
    throw new ConfigurationError("The connector retry policy is invalid.");
  }
  return Object.freeze(value);
}

function identityMatches(result: unknown, identity: ConnectorIdentity): boolean {
  if (result === null || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const connectorId = (result as { connectorId?: unknown }).connectorId;
  return connectorId === undefined || connectorId === identity.connectorId;
}

export class ReceiverConnectorWorker {
  private readonly config: ConnectorConfig;
  private readonly transport: RedriveTransport;
  private readonly dispatcher: CapabilityDispatcher;
  private readonly identityGenerator: IdentityGenerator | undefined;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly retryPolicy: RetryPolicy;
  private readonly idleDelayMs: number;
  private readonly transportFailureDelayMs: number;
  private loadedIdentity: LoadedIdentity | undefined;
  private identity: ConnectorIdentity | undefined;
  private enrollmentRequired = false;
  private started = false;

  constructor(options: ReceiverConnectorWorkerOptions) {
    this.config = options.config;
    this.transport = options.transport;
    this.dispatcher = options.dispatcher;
    this.identityGenerator = options.identityGenerator;
    this.sleep = options.sleep ?? defaultSleep;
    this.retryPolicy = normalizedRetryPolicy(options.retryPolicy);
    this.idleDelayMs = validDelay(options.idleDelayMs, DEFAULT_IDLE_DELAY_MS);
    this.transportFailureDelayMs = validDelay(
      options.transportFailureDelayMs,
      DEFAULT_TRANSPORT_FAILURE_DELAY_MS,
    );
  }

  get currentIdentity(): ConnectorIdentity | undefined {
    return this.identity;
  }

  get identityPath(): string | undefined {
    return this.loadedIdentity?.identityPath;
  }

  async initialize(): Promise<ConnectorIdentity> {
    if (this.started && this.identity !== undefined) return this.identity;
    if (this.loadedIdentity === undefined) {
      this.loadedIdentity = loadOrCreateIdentity({
        stateDir: this.config.connectorStateDir,
        serverOrigin: this.config.redriveUrl,
        generator: this.identityGenerator,
      });
      this.identity = this.loadedIdentity.identity;
      this.enrollmentRequired = !this.loadedIdentity.enrollmentAcknowledged;
    }

    if (this.enrollmentRequired) {
      const enrollmentToken = this.config.enrollmentToken;
      if (enrollmentToken === undefined) {
        throw new ConfigurationError(
          "REDRIVE_ENROLLMENT_TOKEN is required while connector enrollment is not acknowledged.",
        );
      }
      const request: EnrollmentRequest = {
        identity: this.identity as ConnectorIdentity,
        enrollmentToken,
        capabilities: RECEIVER_CAPABILITIES,
      };
      const result = await this.withTransportRetry(() => this.transport.enroll(request));
      if (!identityMatches(result, this.identity as ConnectorIdentity)) {
        throw new ConnectorError(
          "TRANSPORT_ERROR",
          "Central enrollment returned a different connector identity.",
          false,
        );
      }
      this.loadedIdentity = markEnrollmentAcknowledged(this.loadedIdentity);
      this.enrollmentRequired = false;
    }
    this.started = true;
    return this.identity as ConnectorIdentity;
  }

  async runOnce(): Promise<WorkerIteration> {
    const identity = await this.initialize();
    const request: LeaseRequest = {
      identity,
      capabilities: RECEIVER_CAPABILITIES,
    };
    const rawJob = await this.withTransportRetry(() => this.transport.lease(request));
    if (rawJob === null) return { kind: "NO_WORK" };

    let job: CapabilityJob;
    try {
      job = parseCapabilityJob(rawJob);
    } catch (error) {
      const reference = getJobFailureReference(rawJob);
      if (reference === null) throw error;
      const capabilityError = toCapabilityError(error, "INVALID_JOB");
      await this.failJob(identity, reference, capabilityError);
      return { kind: "FAILED", error: capabilityError };
    }

    let normalizedResult: CapabilityResult;
    try {
      const result = await this.dispatcher(job);
      normalizedResult = parseCapabilityResult(job.capability, job.input, result);
    } catch (error) {
      const capabilityError = toCapabilityError(error, "TRANSPORT_ERROR");
      await this.failJob(identity, job, capabilityError);
      return { kind: "FAILED", job, error: capabilityError };
    }
    await this.completeJob(identity, job, normalizedResult);
    return { kind: "COMPLETED", job };
  }

  async run(signal?: AbortSignal): Promise<void> {
    while (!signal?.aborted) {
      try {
        const iteration = await this.runOnce();
        if (iteration.kind === "NO_WORK") {
          await this.sleep(this.idleDelayMs);
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (
          (error instanceof ConnectorError && !error.retryable) ||
          error instanceof CapabilityValidationError
        ) {
          throw error;
        }
        await this.sleep(this.transportFailureDelayMs);
      }
    }
  }

  private async completeJob(
    identity: ConnectorIdentity,
    job: CapabilityJob,
    result: CapabilityResult,
  ): Promise<void> {
    const request: CompleteRequest = {
      identity,
      jobId: job.jobId,
      capability: job.capability,
      input: job.input,
      leaseGeneration: job.leaseGeneration,
      result,
    };
    await this.withTransportRetry(() => this.transport.complete(request));
  }

  private async failJob(
    identity: ConnectorIdentity,
    job: JobFailureReference,
    error: ReturnType<typeof toCapabilityError>,
  ): Promise<void> {
    const request: FailRequest = {
      identity,
      jobId: job.jobId,
      capability: job.capability,
      leaseGeneration: job.leaseGeneration,
      error,
    };
    await this.withTransportRetry(() => this.transport.fail(request));
  }

  private async withTransportRetry<T>(operation: () => Promise<T>): Promise<T> {
    let attempt = 0;
    let delay = this.retryPolicy.initialDelayMs;
    while (true) {
      attempt += 1;
      try {
        return await operation();
      } catch (error) {
        if (attempt >= this.retryPolicy.maxAttempts || !isRetryableTransportError(error)) {
          throw error;
        }
        await this.sleep(delay);
        delay = Math.min(
          this.retryPolicy.maxDelayMs,
          Math.max(delay * 2, this.retryPolicy.initialDelayMs),
        );
      }
    }
  }
}
