import {
  GithubIntegrationStateError,
  type GithubInstallation,
} from "@/domain/github-integration";
import {
  claimInstallationAttempt,
  completeInstallationAttempt,
  getGithubAppRegistration,
  getInstallation,
  markInstallationAttemptRecovery,
} from "@/server/github-app-service";
import { parseGithubInstallation } from "@/server/github-connection-service";
import { createGithubAppJwt } from "@/server/github-app-jwt";
import type { SqliteDatabase } from "@/server/database";
import type { GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";

export class GithubInstallationVerificationError extends Error {
  readonly code: "INVALID_STATE" | "EXPIRED_STATE" | "ALREADY_CLAIMED" | "RECOVERY_REQUIRED" | "REMOTE_INVALID";

  constructor(
    code: GithubInstallationVerificationError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GithubInstallationVerificationError";
    this.code = code;
  }
}

export interface VerifiedInstallationResult {
  installation: GithubInstallation;
  repeated: boolean;
}

function stateErrorCode(error: GithubIntegrationStateError): GithubInstallationVerificationError["code"] {
  if (error.code === "EXPIRED_STATE") return "EXPIRED_STATE";
  if (error.code === "ALREADY_CLAIMED") return "ALREADY_CLAIMED";
  return "INVALID_STATE";
}

export async function verifyAndPersistGithubInstallation(options: {
  database: SqliteDatabase;
  api: GithubApi;
  secretStore: SecretStore;
  state: string;
  installationId: string;
  now?: Date;
}): Promise<VerifiedInstallationResult> {
  const now = options.now ?? new Date();
  let claim;
  try {
    claim = claimInstallationAttempt(options.database, options.state, now);
  } catch (error) {
    if (error instanceof GithubIntegrationStateError) {
      throw new GithubInstallationVerificationError(
        stateErrorCode(error),
        error.message,
      );
    }
    throw error;
  }

  if (claim.kind === "completed") {
    if (claim.attempt.installationId !== options.installationId) {
      throw new GithubInstallationVerificationError(
        "REMOTE_INVALID",
        "The installation callback does not match the completed attempt.",
      );
    }
    const installation = getInstallation(
      options.database,
      options.installationId,
    );
    if (installation === null) {
      throw new GithubInstallationVerificationError(
        "RECOVERY_REQUIRED",
        "The completed GitHub installation is unavailable.",
      );
    }
    return { installation, repeated: true };
  }
  if (claim.kind === "recovery") {
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "The GitHub installation attempt requires recovery.",
    );
  }

  const registration = getGithubAppRegistration(
    options.database,
    claim.attempt.appRegistrationId,
  );
  if (registration === null) {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub App registration is unavailable.",
    );
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "The GitHub App registration requires recovery.",
    );
  }

  let privateKey: string;
  try {
    privateKey = options.secretStore.readPrivateKey(registration.privateKeyRef);
  } catch {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub App private key is unavailable.",
    );
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "The GitHub App private key requires recovery.",
    );
  }

  let appJwt: string;
  try {
    appJwt = createGithubAppJwt({
      appId: registration.githubAppId,
      privateKey,
      now,
    });
  } catch {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub App JWT could not be created.",
    );
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "The GitHub App credentials require recovery.",
    );
  }

  let remoteInstallation: unknown;
  try {
    remoteInstallation = await options.api.getInstallation(
      options.installationId,
      appJwt,
    );
  } catch {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub installation verification had an uncertain outcome.",
    );
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "GitHub installation verification requires recovery.",
    );
  }

  let parsed;
  try {
    parsed = parseGithubInstallation(
      remoteInstallation,
      options.installationId,
      registration.githubAppId,
    );
    // Account IDs and types bind the installation to the state-bound App
    // owner. Logins are intentionally not compared here because GitHub allows
    // an owner to rename its account after App creation.
    if (
      parsed.accountId !== registration.ownerId ||
      parsed.accountType !== registration.ownerType
    ) {
      throw new Error("GitHub installation account did not match the App owner.");
    }
  } catch {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub returned an installation that could not be verified.",
    );
    throw new GithubInstallationVerificationError(
      "REMOTE_INVALID",
      "The GitHub installation could not be verified.",
    );
  }

  try {
    const installation = completeInstallationAttempt(
      options.database,
      claim.attempt.id,
      {
        ...parsed,
        appRegistrationId: registration.id,
        lastVerifiedAt: now.toISOString(),
      },
      now,
    );
    return { installation, repeated: false };
  } catch {
    markInstallationAttemptRecovery(
      options.database,
      claim.attempt.id,
      "GitHub installation was verified but local persistence failed.",
    );
    throw new GithubInstallationVerificationError(
      "RECOVERY_REQUIRED",
      "The verified GitHub installation requires local recovery.",
    );
  }
}
