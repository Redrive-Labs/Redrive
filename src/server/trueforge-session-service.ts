import { randomUUID } from "node:crypto";

import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import {
  getConnectionRecoveryCoordinatorAgentSpec,
  CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION,
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
  TRUEFORGE_REQUEST_TIMEOUT_SECONDS,
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

export class TrueForgeSessionUnavailableError extends Error {
  constructor(incidentId: string) {
    super(`TrueForge session for incident ${incidentId} is not usable.`);
    this.name = "TrueForgeSessionUnavailableError";
  }
}

export class TrueForgeSessionSpecUpgradeError extends Error {
  constructor(incidentId: string, message: string, options?: ErrorOptions) {
    super(
      `TrueForge Coordinator spec for incident ${incidentId} could not be upgraded: ${message}`,
      options,
    );
    this.name = "TrueForgeSessionSpecUpgradeError";
  }
}

export class TrueForgeUnsupportedCoordinatorSpecError extends Error {
  constructor(incidentId: string, version: string) {
    super(
      `TrueForge Coordinator spec version ${version} for incident ${incidentId} is newer than this Redrive version supports.`,
    );
    this.name = "TrueForgeUnsupportedCoordinatorSpecError";
  }
}

type TrueForgeSessionUpgradeClient = TrueForgeSessionClient & {
  updateSession?: (
    sessionId: string,
    spec: TrueForgeApi.AgentSpec,
  ) => Promise<void>;
};

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

// A reservation is stale only after four bounded 15-second create timeouts.
// This leaves room for a slow but still-live owner while allowing a crashed
// owner to stop blocking the incident forever after a restart.
export const TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS =
  TRUEFORGE_REQUEST_TIMEOUT_SECONDS * 4 * 1_000;

function isStaleCreation(
  binding: TrueForgeSessionBinding,
  observedAt: string,
): boolean {
  const createdAtMs = Date.parse(binding.createdAt);
  const observedAtMs = Date.parse(observedAt);

  return (
    Number.isFinite(createdAtMs) &&
    Number.isFinite(observedAtMs) &&
    observedAtMs - createdAtMs >= TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS
  );
}

function staleCreationCutoff(observedAt: string): string {
  const observedAtMs = Date.parse(observedAt);
  if (!Number.isFinite(observedAtMs)) {
    throw new Error("Cannot calculate a stale TrueForge reservation cutoff.");
  }

  return new Date(
    observedAtMs - TRUEFORGE_SESSION_CREATION_STALE_AFTER_MS,
  ).toISOString();
}

export function createTrueForgeSessionService(
  database: SqliteDatabase,
  trueForgeClient: TrueForgeSessionUpgradeClient,
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

  async function recoverStaleCreation(
    binding: TrueForgeSessionBinding,
  ): Promise<TrueForgeSessionEnsureResult> {
    const observedAt = now();
    if (!isStaleCreation(binding, observedAt)) {
      return inProgressResult(binding);
    }

    const creationToken = binding.creationToken;
    if (creationToken === null) {
      throw new TrueForgeSessionBindingError(binding.incidentId);
    }

    const transitioned = bindingRepository.markStaleCreationUncertain(
      binding.incidentId,
      creationToken,
      binding.createdAt,
      staleCreationCutoff(observedAt),
      observedAt,
    );

    if (transitioned) {
      const uncertain = bindingRepository.getByIncidentId(binding.incidentId);
      if (uncertain === null || uncertain.state !== "CREATION_UNCERTAIN") {
        throw new TrueForgeSessionBindingError(binding.incidentId);
      }
      return resultFor(uncertain, "CREATION_UNCERTAIN", {
        retryable: false,
        reused: false,
      });
    }

    // Another actor may have activated or otherwise transitioned this exact
    // reservation. Never overwrite that outcome; classify the durable state
    // that won the CAS instead.
    const current = bindingRepository.getByIncidentId(binding.incidentId);
    if (current === null) {
      throw new TrueForgeSessionBindingError(binding.incidentId);
    }
    if (current.state === "ACTIVE") {
      return verifyActiveBinding(current);
    }
    if (current.state === "CREATING") {
      return inProgressResult(current);
    }
    return blockedResult(current);
  }

  async function classifyExistingBinding(
    binding: TrueForgeSessionBinding,
  ): Promise<TrueForgeSessionEnsureResult> {
    if (binding.state === "ACTIVE") {
      return verifyActiveBinding(binding);
    }
    if (binding.state === "CREATING") {
      return recoverStaleCreation(binding);
    }
    return blockedResult(binding);
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
    // A typo cannot create an unowned remote session. The incident's durable
    // applicationConnectionId is the sole selector for the Coordinator
    // semantic path; no repository, hook, or environment fallback is used.
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new TrueForgeIncidentNotFoundError(incidentId);
    }
    const existing = bindingRepository.getByIncidentId(incidentId);
    if (existing !== null) {
      return classifyExistingBinding(existing);
    }

    // Validate the server-side model/resource name before reserving or
    // creating a remote session. Missing configuration must fail closed.
    const coordinatorAgentSpec =
      getConnectionRecoveryCoordinatorAgentSpec(environment);
    const coordinatorSpecVersion = CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION;

    const creationToken = randomUUID();
    const reservation = bindingRepository.reserveCreation(
      incidentId,
      creationToken,
      coordinatorSpecVersion,
      now(),
    );

    // The reservation may have been won by another process between the read
    // above and the immediate transaction. Only the caller whose token was
    // persisted may issue the remote POST.
    if (
      reservation.state !== "CREATING" ||
      reservation.creationToken !== creationToken
    ) {
      return classifyExistingBinding(reservation);
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

  async function ensureCoordinatorForIncident(
    incidentId: string,
    ensured?: TrueForgeSessionEnsureResult,
  ): Promise<TrueForgeSessionEnsureResult> {
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new TrueForgeIncidentNotFoundError(incidentId);
    }
    const desiredVersion = CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION;
    const acceptedVersions: readonly string[] = [CONNECTION_RECOVERY_COORDINATOR_SPEC_VERSION];

    const session = ensured ?? (await ensure(incidentId));

    if (
      session.state !== "ACTIVE" ||
      session.sessionId === null ||
      (session.outcome !== "CREATED" && session.outcome !== "REUSED")
    ) {
      return session;
    }

    const binding = session.binding;
    if (!acceptedVersions.includes(binding.coordinatorSpecVersion)) {
      throw new TrueForgeUnsupportedCoordinatorSpecError(
        incidentId,
        binding.coordinatorSpecVersion,
      );
    }

    // Reapply the desired spec so runtime-selected model and MCP resources stay
    // current on this same inline session before a turn can begin.
    const coordinatorAgentSpec =
      getConnectionRecoveryCoordinatorAgentSpec(environment);
    if (typeof trueForgeClient.updateSession !== "function") {
      throw new TrueForgeSessionSpecUpgradeError(
        incidentId,
        "the TrueForge client does not support inline session updates",
      );
    }

    try {
      await trueForgeClient.updateSession(session.sessionId, coordinatorAgentSpec);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "remote update failed";
      throw new TrueForgeSessionSpecUpgradeError(incidentId, message, {
        cause: error,
      });
    }

    if (binding.coordinatorSpecVersion === desiredVersion) {
      return session;
    }

    // Upgrade one of the explicitly known prior versions. This CAS follows
    // the remote update, so an active session is never relabeled unless the
    // corresponding current AgentSpec was accepted first.
    for (const expectedVersion of acceptedVersions) {
      if (
        expectedVersion === desiredVersion ||
        binding.coordinatorSpecVersion !== expectedVersion
      ) {
        continue;
      }

      const upgraded = bindingRepository.updateCoordinatorSpecVersion(
        incidentId,
        session.sessionId,
        expectedVersion,
        desiredVersion,
        now(),
      );

      if (upgraded !== null) {
        return resultFor(upgraded, session.outcome, {
          retryable: session.retryable,
          reused: session.reused,
        });
      }
      break;
    }

    const current = bindingRepository.getByIncidentId(incidentId);
    if (
      current?.state === "ACTIVE" &&
      current.trueForgeSessionId === session.sessionId &&
      current.coordinatorSpecVersion === desiredVersion
    ) {
      return resultFor(current, session.outcome, {
        retryable: session.retryable,
        reused: session.reused,
      });
    }

    if (current !== null && current !== undefined) {
      if (!acceptedVersions.includes(current.coordinatorSpecVersion)) {
        throw new TrueForgeUnsupportedCoordinatorSpecError(
          incidentId,
          current.coordinatorSpecVersion,
        );
      }
    }

    throw new TrueForgeSessionSpecUpgradeError(
      incidentId,
      "the durable binding changed before its connection spec version could be recorded",
    );
  }


  return {
    getBindingByIncidentId,
    ensureTrueForgeSession: ensure,
    ensureCoordinatorForIncident,
  };
}

type TrueForgeSessionService = ReturnType<typeof createTrueForgeSessionService>;

function createLazyConfiguredTrueForgeClient(): TrueForgeSessionUpgradeClient {
  let configured: TrueForgeSessionUpgradeClient | undefined;

  function getConfigured(): TrueForgeSessionUpgradeClient {
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
    updateSession(sessionId, spec) {
      return getConfigured().updateSession?.(sessionId, spec) ?? Promise.reject(
        new Error("TrueForge session updates are not configured."),
      );
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
