import { randomUUID } from "node:crypto";

import {
  getRecoveryCoordinatorAgentSpec,
  RECOVERY_COORDINATOR_SPEC_VERSION,
} from "@/agents/recovery-coordinator";
import type {
  TrueForgeSessionBinding,
  TrueForgeSessionBindingState,
} from "@/domain/trueforge-session";
import type { SqliteDatabase } from "@/server/database";
import { getConfiguredDatabase } from "@/server/database";
import { getServerConfig } from "@/server/config";
import { createIncidentService } from "@/server/incident-service";
import {
  createConfiguredTrueForgeClient,
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
  TrueForgeSessionNotFoundError,
  type TrueForgeSessionClient,
  type TrueForgeSessionCreateResult,
} from "@/server/trueforge-client";
import { createTrueForgeSessionBindingRepository } from "@/server/trueforge-session-binding-repository";

export type TrueForgeSessionEnsureOutcome =
  | "CREATED"
  | "REUSED"
  | "IN_PROGRESS"
  | "CREATION_UNCERTAIN"
  | "LOST"
  | "TRANSIENT_LOOKUP_FAILURE";

export interface TrueForgeSessionEnsureResult {
  binding: TrueForgeSessionBinding;
  state: TrueForgeSessionBindingState;
  sessionId: string | null;
  outcome: TrueForgeSessionEnsureOutcome;
  retryable: boolean;
  reused: boolean;
}

export class TrueForgeIncidentNotFoundError extends Error {
  constructor(incidentId: string) {
    super(`Incident ${incidentId} was not found.`);
    this.name = "TrueForgeIncidentNotFoundError";
  }
}

export class TrueForgeSessionBindingError extends Error {
  constructor(incidentId: string, options?: ErrorOptions) {
    super(
      `TrueForge session for incident ${incidentId} could not be durably bound.`,
      options,
    );
    this.name = "TrueForgeSessionBindingError";
  }
}

function resultFor(
  binding: TrueForgeSessionBinding,
  outcome: TrueForgeSessionEnsureOutcome,
  options: { retryable: boolean; reused: boolean },
): TrueForgeSessionEnsureResult {
  return {
    binding,
    state: binding.state,
    sessionId: binding.trueForgeSessionId,
    outcome,
    retryable: options.retryable,
    reused: options.reused,
  };
}

function readCreatedSessionId(result: TrueForgeSessionCreateResult): string {
  const sessionId =
    typeof result === "string"
      ? result
      : result !== null && typeof result === "object"
        ? result.id
        : null;

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    throw new TrueForgeSessionCreateError(
      "AMBIGUOUS",
      "TrueForge returned a session without a valid opaque ID.",
    );
  }

  return sessionId;
}

function isDefinitiveCreateFailure(error: unknown): boolean {
  return (
    error instanceof TrueForgeConfigurationError ||
    (error instanceof TrueForgeSessionCreateError &&
      error.kind === "DEFINITIVE")
  );
}

export function createTrueForgeSessionService(
  database: SqliteDatabase,
  trueForgeClient: TrueForgeSessionClient,
  now: () => string = () => new Date().toISOString(),
  environment: NodeJS.ProcessEnv = process.env,
) {
  const incidentService = createIncidentService(database);
  const bindingRepository = createTrueForgeSessionBindingRepository(database);

  function getBindingByIncidentId(
    incidentId: string,
  ): TrueForgeSessionBinding | null {
    return bindingRepository.getByIncidentId(incidentId);
  }

  function inProgressResult(
    binding: TrueForgeSessionBinding,
  ): TrueForgeSessionEnsureResult {
    return resultFor(binding, "IN_PROGRESS", {
      retryable: true,
      reused: false,
    });
  }

  function blockedResult(
    binding: TrueForgeSessionBinding,
  ): TrueForgeSessionEnsureResult {
    const outcome =
      binding.state === "CREATION_UNCERTAIN" ? "CREATION_UNCERTAIN" : "LOST";
    return resultFor(binding, outcome, {
      retryable: false,
      reused: false,
    });
  }

  async function verifyActiveBinding(
    binding: TrueForgeSessionBinding,
  ): Promise<TrueForgeSessionEnsureResult> {
    const sessionId = binding.trueForgeSessionId;
    if (sessionId === null) {
      throw new TrueForgeSessionBindingError(binding.incidentId);
    }

    try {
      await trueForgeClient.getSession(sessionId);
      return resultFor(binding, "REUSED", {
        retryable: false,
        reused: true,
      });
    } catch (error) {
      // Only the adapter's explicit not-found error is authoritative evidence
      // that a remote session disappeared. Every other lookup failure leaves
      // the durable ACTIVE binding untouched.
      if (error instanceof TrueForgeSessionNotFoundError) {
        const lost = bindingRepository.markLost(
          binding.incidentId,
          sessionId,
          now(),
        );
        if (lost !== null) {
          return resultFor(lost, "LOST", {
            retryable: false,
            reused: false,
          });
        }

        const current = bindingRepository.getByIncidentId(binding.incidentId);
        if (current === null) {
          throw new TrueForgeSessionBindingError(binding.incidentId, {
            cause: error,
          });
        }
        if (current.state === "LOST") {
          return resultFor(current, "LOST", {
            retryable: false,
            reused: false,
          });
        }
        if (current.state === "ACTIVE") {
          return resultFor(current, "TRANSIENT_LOOKUP_FAILURE", {
            retryable: true,
            reused: true,
          });
        }
        return current.state === "CREATING"
          ? inProgressResult(current)
          : blockedResult(current);
      }

      return resultFor(binding, "TRANSIENT_LOOKUP_FAILURE", {
        retryable: true,
        reused: true,
      });
    }
  }

  async function ensure(incidentId: string): Promise<TrueForgeSessionEnsureResult> {
    // This check intentionally precedes reservation and every client call.
    // A typo cannot create an unowned remote session.
    if (incidentService.getById(incidentId) === null) {
      throw new TrueForgeIncidentNotFoundError(incidentId);
    }

    const existing = bindingRepository.getByIncidentId(incidentId);
    if (existing !== null) {
      if (existing.state === "ACTIVE") {
        return verifyActiveBinding(existing);
      }
      if (existing.state === "CREATING") {
        return inProgressResult(existing);
      }
      return blockedResult(existing);
    }

    // Validate the server-side model/resource name before reserving or
    // creating a remote session. Missing configuration must fail closed.
    const coordinatorAgentSpec = getRecoveryCoordinatorAgentSpec(environment);

    const creationToken = randomUUID();
    const reservation = bindingRepository.reserveCreation(
      incidentId,
      creationToken,
      RECOVERY_COORDINATOR_SPEC_VERSION,
      now(),
    );

    // The reservation may have been won by another process between the read
    // above and the immediate transaction. Only the caller whose token was
    // persisted may issue the remote POST.
    if (
      reservation.state !== "CREATING" ||
      reservation.creationToken !== creationToken
    ) {
      if (reservation.state === "ACTIVE") {
        return verifyActiveBinding(reservation);
      }
      if (reservation.state === "CREATING") {
        return inProgressResult(reservation);
      }
      return blockedResult(reservation);
    }

    let sessionId: string;
    try {
      sessionId = readCreatedSessionId(
        await trueForgeClient.createSession(coordinatorAgentSpec),
      );
    } catch (error) {
      if (isDefinitiveCreateFailure(error)) {
        // The SDK's definite 4xx response means no remote session was
        // accepted. Removing only this token's reservation permits a safe
        // later retry.
        bindingRepository.releaseCreation(incidentId, creationToken);
        throw error;
      }

      const uncertain = bindingRepository.markCreationUncertain(
        incidentId,
        creationToken,
        now(),
      );
      if (!uncertain) {
        throw new TrueForgeSessionBindingError(incidentId, { cause: error });
      }

      const binding = bindingRepository.getByIncidentId(incidentId);
      if (binding === null || binding.state !== "CREATION_UNCERTAIN") {
        throw new TrueForgeSessionBindingError(incidentId, { cause: error });
      }

      return resultFor(binding, "CREATION_UNCERTAIN", {
        retryable: false,
        reused: false,
      });
    }

    // The remote request is complete before this short CAS transaction. The
    // exact opaque ID is persisted only by the reservation owner.
    const active = bindingRepository.activate(
      incidentId,
      creationToken,
      sessionId,
      now(),
    );
    if (active === null) {
      throw new TrueForgeSessionBindingError(incidentId);
    }

    return resultFor(active, "CREATED", {
      retryable: false,
      reused: false,
    });
  }

  return {
    getBindingByIncidentId,
    ensureTrueForgeSession: ensure,
  };
}

type TrueForgeSessionService = ReturnType<typeof createTrueForgeSessionService>;

function createLazyConfiguredTrueForgeClient(): TrueForgeSessionClient {
  let configured: TrueForgeSessionClient | undefined;

  function getConfigured(): TrueForgeSessionClient {
    configured ??= createConfiguredTrueForgeClient();
    return configured;
  }

  return {
    createSession(spec) {
      return getConfigured().createSession(spec);
    },
    getSession(sessionId) {
      return getConfigured().getSession(sessionId);
    },
  };
}

function withConfiguredTrueForgeService<T>(
  operation: (service: TrueForgeSessionService) => T,
): T {
  const database = getConfiguredDatabase(getServerConfig().databasePath);
  return operation(
    createTrueForgeSessionService(
      database,
      createLazyConfiguredTrueForgeClient(),
    ),
  );
}

export async function ensureTrueForgeSession(
  incidentId: string,
): Promise<TrueForgeSessionEnsureResult> {
  return withConfiguredTrueForgeService((service) =>
    service.ensureTrueForgeSession(incidentId),
  );
}

export async function getTrueForgeSessionBinding(
  incidentId: string,
): Promise<TrueForgeSessionBinding | null> {
  return withConfiguredTrueForgeService((service) =>
    service.getBindingByIncidentId(incidentId),
  );
}
