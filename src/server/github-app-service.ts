import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  APPLICATION_CONNECTION_READY,
  GITHUB_PROVIDER,
  GithubIntegrationStateError,
  GithubIntegrationValidationError,
  INSTALLATION_ATTEMPT_COMPLETED,
  INSTALLATION_ATTEMPT_PENDING,
  INSTALLATION_ATTEMPT_RECOVERY_REQUIRED,
  INSTALLATION_ATTEMPT_VERIFYING,
  MANIFEST_ATTEMPT_COMPLETED,
  MANIFEST_ATTEMPT_EXCHANGING,
  MANIFEST_ATTEMPT_PENDING,
  MANIFEST_ATTEMPT_RECOVERY_REQUIRED,
  type GithubAccountType,
  type GithubAppRegistration,
  type GithubInstallation,
  type ManifestAttemptStatus,
  type ManifestTargetType,
  isRecord,
  parseManifestTarget,
  readOpaqueGithubIdentifier,
  readRequiredText,
  githubLoginsEqual,
  timingSafeStringEqual,
  validateGithubLogin,
} from "@/domain/github-integration";
import { deriveRedriveUrl } from "@/server/config";
import { manifestPrivateKeyReference } from "@/server/secret-store";
import type { SqliteDatabase } from "@/server/database";

export const MANIFEST_ATTEMPT_TTL_MS = 30 * 60 * 1000;
export const INSTALLATION_ATTEMPT_TTL_MS = 30 * 60 * 1000;
// A claimed one-time operation cannot safely be retried after its worker may
// have reached GitHub. A stale claim therefore moves to recovery rather than
// issuing a second conversion or verification request.
export const MANIFEST_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;
export const INSTALLATION_CLAIM_STALE_AFTER_MS = 5 * 60 * 1000;

export interface GithubAppManifest {
  name: string;
  url: string;
  hook_attributes: {
    url: string;
    active: false;
  };
  redirect_url: string;
  setup_url: string;
  setup_on_update: true;
  public: false;
  default_permissions: {
    contents: "read";
    repository_hooks: "write";
  };
  default_events: [];
  request_oauth_on_install: false;
}

export interface ManifestAttempt {
  id: string;
  targetType: ManifestTargetType;
  ownerLogin: string | null;
  status: ManifestAttemptStatus;
  expiresAt: string;
  claimedAt: string | null;
  appRegistrationId: string | null;
  remoteGithubAppId: string | null;
  remoteSlug: string | null;
  remoteOwnerId: string | null;
  remoteOwnerLogin: string | null;
  remoteOwnerType: GithubAccountType | null;
  privateKeySha256: string | null;
  recoveryReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface InstallationAttempt {
  id: string;
  appRegistrationId: string;
  status:
    | typeof INSTALLATION_ATTEMPT_PENDING
    | typeof INSTALLATION_ATTEMPT_VERIFYING
    | typeof INSTALLATION_ATTEMPT_COMPLETED
    | typeof INSTALLATION_ATTEMPT_RECOVERY_REQUIRED;
  expiresAt: string;
  claimedAt: string | null;
  installationId: string | null;
  recoveryReason: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ParsedManifestConversion {
  githubAppId: string;
  slug: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: GithubAccountType;
  privateKeyPem: string;
}

export interface ManifestConversionCheckpoint {
  githubAppId: string;
  slug: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: GithubAccountType;
  privateKeySha256: string;
}

export interface CreatedManifestAttempt {
  attempt: ManifestAttempt;
  state: string;
  manifest: GithubAppManifest;
  githubRegistrationUrl: string;
}

export interface CreatedInstallationAttempt {
  attempt: InstallationAttempt;
  state: string;
  githubInstallationUrl: string;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function makeStateToken(): string {
  return randomBytes(32).toString("base64url");
}

function toIso(value: Date | string | number): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GithubIntegrationValidationError("A valid clock value is required.");
  }
  return date.toISOString();
}

function readRowText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`GitHub integration row has an invalid ${field} value.`);
  }
  return value;
}

function readRowNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`GitHub integration row has an invalid ${field} value.`);
  }
  return value;
}

function readCheckpointNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  // Preserve an invalid non-text value as an invalid empty checkpoint value.
  // Claim/reconciliation then fails closed instead of treating it as absent.
  return typeof value === "string" ? value : "";
}

function mapManifestAttempt(row: Record<string, unknown>): ManifestAttempt {
  const status = readRowText(row, "status") as ManifestAttemptStatus;
  if (
    status !== MANIFEST_ATTEMPT_PENDING &&
    status !== MANIFEST_ATTEMPT_EXCHANGING &&
    status !== MANIFEST_ATTEMPT_COMPLETED &&
    status !== MANIFEST_ATTEMPT_RECOVERY_REQUIRED
  ) {
    throw new Error("GitHub manifest attempt has an invalid status.");
  }
  return {
    id: readRowText(row, "id"),
    targetType: readRowText(row, "target_type") as ManifestTargetType,
    ownerLogin: readRowNullableText(row, "owner_login"),
    status,
    expiresAt: readRowText(row, "expires_at"),
    claimedAt: readRowNullableText(row, "claimed_at"),
    appRegistrationId: readRowNullableText(row, "app_registration_id"),
    remoteGithubAppId: readRowNullableText(row, "remote_github_app_id"),
    remoteSlug: readRowNullableText(row, "remote_slug"),
    remoteOwnerId: readCheckpointNullableText(row, "remote_owner_id"),
    remoteOwnerLogin: readCheckpointNullableText(row, "remote_owner_login"),
    remoteOwnerType: readCheckpointNullableText(row, "remote_owner_type") as GithubAccountType | null,
    privateKeySha256: readCheckpointNullableText(row, "private_key_sha256"),
    recoveryReason: readRowNullableText(row, "recovery_reason"),
    createdAt: readRowText(row, "created_at"),
    updatedAt: readRowText(row, "updated_at"),
    completedAt: readRowNullableText(row, "completed_at"),
  };
}

function mapRegistration(row: Record<string, unknown>): GithubAppRegistration {
  const ownerType = readRowText(row, "owner_type");
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new Error("GitHub App registration has an invalid owner type.");
  }
  return {
    id: readRowText(row, "id"),
    githubAppId: readRowText(row, "github_app_id"),
    slug: readRowText(row, "slug"),
    ownerId: readRowText(row, "owner_id"),
    ownerLogin: readRowText(row, "owner_login"),
    ownerType,
    privateKeyRef: readRowText(row, "private_key_ref"),
    createdAt: readRowText(row, "created_at"),
    updatedAt: readRowText(row, "updated_at"),
  };
}

function mapInstallationAttempt(row: Record<string, unknown>): InstallationAttempt {
  const status = readRowText(row, "status");
  if (
    status !== INSTALLATION_ATTEMPT_PENDING &&
    status !== INSTALLATION_ATTEMPT_VERIFYING &&
    status !== INSTALLATION_ATTEMPT_COMPLETED &&
    status !== INSTALLATION_ATTEMPT_RECOVERY_REQUIRED
  ) {
    throw new Error("GitHub installation attempt has an invalid status.");
  }
  return {
    id: readRowText(row, "id"),
    appRegistrationId: readRowText(row, "app_registration_id"),
    status,
    expiresAt: readRowText(row, "expires_at"),
    claimedAt: readRowNullableText(row, "claimed_at"),
    installationId: readRowNullableText(row, "installation_id"),
    recoveryReason: readRowNullableText(row, "recovery_reason"),
    createdAt: readRowText(row, "created_at"),
    updatedAt: readRowText(row, "updated_at"),
    completedAt: readRowNullableText(row, "completed_at"),
  };
}

function mapInstallation(row: Record<string, unknown>): GithubInstallation {
  const accountType = readRowText(row, "account_type");
  if (accountType !== "User" && accountType !== "Organization") {
    throw new Error("GitHub installation has an invalid account type.");
  }
  const repositorySelection = readRowText(row, "repository_selection");
  if (repositorySelection !== "all" && repositorySelection !== "selected") {
    throw new Error("GitHub installation has an invalid repository selection.");
  }
  return {
    installationId: readRowText(row, "installation_id"),
    appRegistrationId: readRowText(row, "app_registration_id"),
    accountId: readRowText(row, "account_id"),
    accountLogin: readRowText(row, "account_login"),
    accountType,
    repositorySelection,
    lastVerifiedAt: readRowText(row, "last_verified_at"),
    createdAt: readRowText(row, "created_at"),
    updatedAt: readRowText(row, "updated_at"),
  };
}

function appName(): string {
  return `Redrive Recovery ${randomBytes(4).toString("hex")}`;
}

export function buildGithubAppManifest(
  publicUrl: string,
): GithubAppManifest {
  return {
    name: appName(),
    url: publicUrl,
    hook_attributes: {
      url: deriveRedriveUrl(
        publicUrl,
        "/api/integrations/github/app-webhook-disabled",
      ),
      active: false,
    },
    redirect_url: deriveRedriveUrl(
      publicUrl,
      "/api/integrations/github/app-manifest/callback",
    ),
    setup_url: deriveRedriveUrl(
      publicUrl,
      "/api/integrations/github/install/callback",
    ),
    setup_on_update: true,
    public: false,
    default_permissions: {
      contents: "read",
      repository_hooks: "write",
    },
    default_events: [],
    request_oauth_on_install: false,
  };
}

export function createManifestAttempt(
  database: SqliteDatabase,
  input: unknown,
  publicUrl: string,
  now = new Date(),
): CreatedManifestAttempt {
  const target = parseManifestTarget(input);
  const startedAt = toIso(now);
  const expiresAt = new Date(now.getTime() + MANIFEST_ATTEMPT_TTL_MS).toISOString();
  const attemptId = randomUUID();
  const state = makeStateToken();
  const manifest = buildGithubAppManifest(publicUrl);
  const registrationPath =
    target.targetType === "personal"
      ? "settings/apps/new"
      : `organizations/${encodeURIComponent(target.ownerLogin as string)}/settings/apps/new`;
  const githubRegistrationUrl =
    `https://github.com/${registrationPath}?state=${encodeURIComponent(state)}`;

  database.run(
    `
      INSERT INTO github_manifest_attempts (
        id, state_hash, target_type, owner_login, status, expires_at,
        created_at, updated_at
      ) VALUES (
        @id, @stateHash, @targetType, @ownerLogin, @status, @expiresAt,
        @createdAt, @updatedAt
      )
    `,
    {
      id: attemptId,
      stateHash: hashToken(state),
      targetType: target.targetType,
      ownerLogin: target.ownerLogin,
      status: MANIFEST_ATTEMPT_PENDING,
      expiresAt,
      createdAt: startedAt,
      updatedAt: startedAt,
    },
  );

  const row = database.get<Record<string, unknown>>(
    `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
            app_registration_id, remote_github_app_id, remote_slug,
            remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
            recovery_reason, created_at, updated_at, completed_at
       FROM github_manifest_attempts WHERE id = ?`,
    [attemptId],
  );
  if (row === undefined) {
    throw new Error("GitHub manifest attempt could not be read back.");
  }
  return {
    attempt: mapManifestAttempt(row),
    state,
    manifest,
    githubRegistrationUrl,
  };
}

function getManifestAttemptByStateHash(
  database: SqliteDatabase,
  state: string,
): ManifestAttempt | null {
  if (typeof state !== "string" || state.length < 32 || state.length > 256) {
    return null;
  }
  const stateHash = hashToken(state);
  const row = database.get<Record<string, unknown>>(
    `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
            app_registration_id, remote_github_app_id, remote_slug,
            remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
            recovery_reason, created_at, updated_at, completed_at, state_hash
       FROM github_manifest_attempts WHERE state_hash = ?`,
    [stateHash],
  );
  if (row === undefined || !timingSafeStringEqual(readRowText(row, "state_hash"), stateHash)) {
    return null;
  }
  return mapManifestAttempt(row);
}

export type ManifestClaim =
  | { kind: "claimed"; attempt: ManifestAttempt }
  | { kind: "reconciliation"; attempt: ManifestAttempt }
  | { kind: "completed"; attempt: ManifestAttempt }
  | { kind: "recovery"; attempt: ManifestAttempt };

type StoredCheckpoint =
  | { kind: "absent" }
  | { kind: "partial" }
  | { kind: "invalid" }
  | { kind: "complete"; checkpoint: ManifestConversionCheckpoint };

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

function validateCheckpoint(value: {
  githubAppId: unknown;
  slug: unknown;
  ownerId: unknown;
  ownerLogin: unknown;
  ownerType: unknown;
  privateKeySha256: unknown;
}): ManifestConversionCheckpoint {
  const githubAppId = readOpaqueGithubIdentifier(value.githubAppId, "App ID");
  const slug = readRequiredText(value.slug, "App slug", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)) {
    throw new GithubIntegrationValidationError("GitHub App slug is invalid.");
  }
  const ownerId = readOpaqueGithubIdentifier(value.ownerId, "owner ID");
  const ownerLogin = validateGithubLogin(value.ownerLogin, "owner login");
  const ownerType = value.ownerType;
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new GithubIntegrationValidationError("GitHub App owner type is invalid.");
  }
  if (
    typeof value.privateKeySha256 !== "string" ||
    !SHA256_HEX_PATTERN.test(value.privateKeySha256)
  ) {
    throw new GithubIntegrationValidationError("GitHub App private-key checkpoint is invalid.");
  }
  return {
    githubAppId,
    slug,
    ownerId,
    ownerLogin,
    ownerType,
    privateKeySha256: value.privateKeySha256,
  };
}

function checkpointForAttempt(attempt: ManifestAttempt): StoredCheckpoint {
  const values = [
    attempt.remoteGithubAppId,
    attempt.remoteSlug,
    attempt.remoteOwnerId,
    attempt.remoteOwnerLogin,
    attempt.remoteOwnerType,
    attempt.privateKeySha256,
  ];
  if (values.every((value) => value === null)) return { kind: "absent" };
  if (values.some((value) => value === null)) return { kind: "partial" };
  try {
    return {
      kind: "complete",
      checkpoint: validateCheckpoint({
        githubAppId: attempt.remoteGithubAppId as string,
        slug: attempt.remoteSlug as string,
        ownerId: attempt.remoteOwnerId as string,
        ownerLogin: attempt.remoteOwnerLogin as string,
        ownerType: attempt.remoteOwnerType,
        privateKeySha256: attempt.privateKeySha256,
      }),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function checkpointMatchesTarget(
  attempt: Pick<ManifestAttempt, "targetType" | "ownerLogin">,
  checkpoint: ManifestConversionCheckpoint,
): boolean {
  return (
    (attempt.targetType === "personal" && checkpoint.ownerType === "User") ||
    (attempt.targetType === "organization" &&
      checkpoint.ownerType === "Organization" &&
      githubLoginsEqual(checkpoint.ownerLogin, attempt.ownerLogin ?? ""))
  );
}

export function claimManifestAttempt(
  database: SqliteDatabase,
  state: string,
  now = new Date(),
): ManifestClaim {
  const result = database.transaction(() => {
    const attempt = getManifestAttemptByStateHash(database, state);
    if (attempt === null) {
      throw new GithubIntegrationStateError(
        "INVALID_STATE",
        "The GitHub App manifest state is invalid.",
      );
    }

    const checkpoint = checkpointForAttempt(attempt);
    const failClosed = (reason: string): ManifestClaim => {
      const recovered = database.run(
        `UPDATE github_manifest_attempts
            SET status = ?, recovery_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
        [
          MANIFEST_ATTEMPT_RECOVERY_REQUIRED,
          reason,
          now.toISOString(),
          attempt.id,
          MANIFEST_ATTEMPT_EXCHANGING,
        ],
      );
      if (recovered.changes !== 1) {
        throw new GithubIntegrationStateError(
          "ALREADY_CLAIMED",
          "The GitHub App manifest attempt is already being resolved.",
        );
      }
      const recoveredRow = database.get<Record<string, unknown>>(
        `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
                app_registration_id, remote_github_app_id, remote_slug,
                remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
                recovery_reason, created_at, updated_at, completed_at
           FROM github_manifest_attempts WHERE id = ?`,
        [attempt.id],
      );
      if (recoveredRow === undefined) throw new Error("Manifest recovery could not be read back.");
      return { kind: "recovery", attempt: mapManifestAttempt(recoveredRow) } as const;
    };

    if (attempt.status === MANIFEST_ATTEMPT_COMPLETED) {
      return { kind: "completed", attempt } as const;
    }
    if (attempt.status === MANIFEST_ATTEMPT_RECOVERY_REQUIRED) {
      if (
        attempt.appRegistrationId !== null ||
        checkpoint.kind !== "complete" ||
        !checkpointMatchesTarget(attempt, checkpoint.checkpoint)
      ) {
        return { kind: "recovery", attempt } as const;
      }
      const claimedAt = now.toISOString();
      const claimed = database.run(
        `UPDATE github_manifest_attempts
            SET status = ?, claimed_at = ?, recovery_reason = NULL, updated_at = ?
          WHERE id = ? AND status = ?`,
        [MANIFEST_ATTEMPT_EXCHANGING, claimedAt, claimedAt, attempt.id, MANIFEST_ATTEMPT_RECOVERY_REQUIRED],
      );
      if (claimed.changes !== 1) {
        throw new GithubIntegrationStateError(
          "ALREADY_CLAIMED",
          "The GitHub App manifest attempt is already being resolved.",
        );
      }
      const row = database.get<Record<string, unknown>>(
        `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
                app_registration_id, remote_github_app_id, remote_slug,
                remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
                recovery_reason, created_at, updated_at, completed_at
           FROM github_manifest_attempts WHERE id = ?`,
        [attempt.id],
      );
      if (row === undefined) throw new Error("Manifest reconciliation claim could not be read back.");
      return { kind: "reconciliation", attempt: mapManifestAttempt(row) } as const;
    }
    if (attempt.status === MANIFEST_ATTEMPT_EXCHANGING) {
      if (attempt.appRegistrationId !== null) {
        return failClosed("Manifest attempt has a conflicting registration; manual recovery is required.");
      }
      if (checkpoint.kind === "partial" || checkpoint.kind === "invalid") {
        return failClosed("Manifest conversion checkpoint is incomplete or invalid; manual recovery is required.");
      }
      const claimedAt = attempt.claimedAt === null ? NaN : Date.parse(attempt.claimedAt);
      const expiresAt = Date.parse(attempt.expiresAt);
      const claimIsStale =
        !Number.isFinite(claimedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now.getTime() ||
        now.getTime() - claimedAt >= MANIFEST_CLAIM_STALE_AFTER_MS;
      if (claimIsStale) {
        if (checkpoint.kind === "complete" && checkpointMatchesTarget(attempt, checkpoint.checkpoint)) {
          const refreshed = database.run(
            `UPDATE github_manifest_attempts
                SET claimed_at = ?, updated_at = ?
              WHERE id = ? AND status = ?`,
            [now.toISOString(), now.toISOString(), attempt.id, MANIFEST_ATTEMPT_EXCHANGING],
          );
          if (refreshed.changes === 1) {
            const row = database.get<Record<string, unknown>>(
              `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
                      app_registration_id, remote_github_app_id, remote_slug,
                      remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
                      recovery_reason, created_at, updated_at, completed_at
                 FROM github_manifest_attempts WHERE id = ?`,
              [attempt.id],
            );
            if (row === undefined) throw new Error("Manifest reconciliation claim could not be read back.");
            return { kind: "reconciliation", attempt: mapManifestAttempt(row) } as const;
          }
        } else if (checkpoint.kind === "absent") {
          return failClosed("Manifest conversion claim became stale; manual recovery is required.");
        } else {
          return failClosed("Manifest conversion checkpoint is invalid; manual recovery is required.");
        }
      }
      throw new GithubIntegrationStateError(
        "ALREADY_CLAIMED",
        "The GitHub App manifest attempt is already being resolved.",
      );
    }

    if (attempt.appRegistrationId !== null || checkpoint.kind !== "absent") {
      // A checkpoint or registration on a pending attempt is contradictory and must never be
      // used to start conversion or registration.
      const updated = database.run(
        `UPDATE github_manifest_attempts
            SET status = ?, recovery_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
        [MANIFEST_ATTEMPT_RECOVERY_REQUIRED, "Manifest checkpoint contradicts pending state; manual recovery is required.", now.toISOString(), attempt.id, MANIFEST_ATTEMPT_PENDING],
      );
      if (updated.changes === 1) {
        const row = getManifestAttemptByStateHash(database, state);
        if (row === null) throw new Error("Manifest recovery could not be read back.");
        return { kind: "recovery", attempt: row } as const;
      }
      throw new GithubIntegrationStateError("ALREADY_CLAIMED", "The GitHub App manifest attempt is already being resolved.");
    }
    const expiresAt = Date.parse(attempt.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      database.run(
        `UPDATE github_manifest_attempts
            SET status = ?, recovery_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
        [MANIFEST_ATTEMPT_RECOVERY_REQUIRED, "Manifest attempt expired before conversion.", now.toISOString(), attempt.id, MANIFEST_ATTEMPT_PENDING],
      );
      return { kind: "expired" } as const;
    }
    const updatedAt = now.toISOString();
    const update = database.run(
      `UPDATE github_manifest_attempts
          SET status = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?`,
      [MANIFEST_ATTEMPT_EXCHANGING, updatedAt, updatedAt, attempt.id, MANIFEST_ATTEMPT_PENDING],
    );
    if (update.changes !== 1) {
      throw new GithubIntegrationStateError("ALREADY_CLAIMED", "The GitHub App manifest attempt is already being resolved.");
    }
    const claimed = database.get<Record<string, unknown>>(
      `SELECT id, target_type, owner_login, status, expires_at, claimed_at,
              app_registration_id, remote_github_app_id, remote_slug,
              remote_owner_id, remote_owner_login, remote_owner_type, private_key_sha256,
              recovery_reason, created_at, updated_at, completed_at
         FROM github_manifest_attempts WHERE id = ?`,
      [attempt.id],
    );
    if (claimed === undefined) throw new Error("Manifest claim could not be read back.");
    return { kind: "claimed", attempt: mapManifestAttempt(claimed) } as const;
  }, "immediate");

  if (result.kind === "expired") {
    throw new GithubIntegrationStateError("EXPIRED_STATE", "The GitHub App manifest state has expired.");
  }
  return result;
}

export function recordManifestConversionCheckpoint(
  database: SqliteDatabase,
  attemptId: string,
  conversion: ParsedManifestConversion,
  now = new Date(),
): void {
  const privateKeySha256 = createHash("sha256")
    .update(Buffer.from(conversion.privateKeyPem, "utf8"))
    .digest("hex");
  const checkpoint = validateCheckpoint({ ...conversion, privateKeySha256 });
  const row = database.get<Record<string, unknown>>(
    `SELECT id, target_type, owner_login, status,
            remote_github_app_id, remote_slug, remote_owner_id,
            remote_owner_login, remote_owner_type, private_key_sha256
       FROM github_manifest_attempts WHERE id = ?`,
    [attemptId],
  );
  if (row === undefined) throw new Error("GitHub manifest attempt was not found.");
  const attempt = {
    id: readRowText(row, "id"),
    targetType: readRowText(row, "target_type") as ManifestTargetType,
    ownerLogin: readRowNullableText(row, "owner_login"),
    status: readRowText(row, "status") as ManifestAttemptStatus,
    remoteGithubAppId: readCheckpointNullableText(row, "remote_github_app_id"),
    remoteSlug: readCheckpointNullableText(row, "remote_slug"),
    remoteOwnerId: readCheckpointNullableText(row, "remote_owner_id"),
    remoteOwnerLogin: readCheckpointNullableText(row, "remote_owner_login"),
    remoteOwnerType: readCheckpointNullableText(row, "remote_owner_type") as GithubAccountType | null,
    privateKeySha256: readCheckpointNullableText(row, "private_key_sha256"),
  };
  if (attempt.status !== MANIFEST_ATTEMPT_EXCHANGING) {
    throw new Error("GitHub manifest attempt is no longer exchanging.");
  }
  if (!checkpointMatchesTarget(attempt, checkpoint)) {
    throw new Error("GitHub App owner did not match the state-bound target.");
  }
  const existingFields = [
    attempt.remoteGithubAppId,
    attempt.remoteSlug,
    attempt.remoteOwnerId,
    attempt.remoteOwnerLogin,
    attempt.remoteOwnerType,
    attempt.privateKeySha256,
  ];
  if (existingFields.some((value) => value !== null)) {
    throw new Error("GitHub manifest conversion checkpoint conflicts with stored state.");
  }
  const result = database.run(
    `UPDATE github_manifest_attempts
        SET remote_github_app_id = ?, remote_slug = ?, remote_owner_id = ?,
            remote_owner_login = ?, remote_owner_type = ?, private_key_sha256 = ?,
            updated_at = ?
      WHERE id = ? AND status = ?
        AND remote_github_app_id IS NULL AND remote_slug IS NULL
        AND remote_owner_id IS NULL AND remote_owner_login IS NULL
        AND remote_owner_type IS NULL AND private_key_sha256 IS NULL`,
    [checkpoint.githubAppId, checkpoint.slug, checkpoint.ownerId, checkpoint.ownerLogin, checkpoint.ownerType, checkpoint.privateKeySha256, toIso(now), attemptId, MANIFEST_ATTEMPT_EXCHANGING],
  );
  if (result.changes !== 1) throw new Error("GitHub manifest conversion checkpoint conflicts with stored state.");
}

export function markManifestAttemptRecovery(
  database: SqliteDatabase,
  attemptId: string,
  reason = "Manifest conversion requires recovery.",
): void {
  database.run(
    `UPDATE github_manifest_attempts
        SET status = ?, recovery_reason = ?, updated_at = ?
      WHERE id = ? AND status = ?`,
    [
      MANIFEST_ATTEMPT_RECOVERY_REQUIRED,
      reason.slice(0, 512),
      new Date().toISOString(),
      attemptId,
      MANIFEST_ATTEMPT_EXCHANGING,
    ],
  );
}

export function parseManifestConversion(value: unknown): ParsedManifestConversion {
  if (!isRecord(value)) {
    throw new GithubIntegrationValidationError(
      "GitHub App conversion response is invalid.",
    );
  }
  const githubAppId = readOpaqueGithubIdentifier(
    value.app_id ?? value.id,
    "App ID",
  );
  if (value.app_id !== undefined && value.id !== undefined) {
    const responseId = readOpaqueGithubIdentifier(value.id, "App ID");
    if (responseId !== githubAppId) {
      throw new GithubIntegrationValidationError(
        "GitHub App conversion returned conflicting App IDs.",
      );
    }
  }
  const slug = readRequiredText(value.slug, "App slug", 255);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)) {
    throw new GithubIntegrationValidationError("GitHub App slug is invalid.");
  }
  const privateKeyPem = readRequiredText(value.pem, "private key", 128 * 1024);
  if (
    !privateKeyPem.includes("PRIVATE KEY") ||
    !privateKeyPem.includes("BEGIN") ||
    !privateKeyPem.includes("END")
  ) {
    throw new GithubIntegrationValidationError(
      "GitHub App conversion did not return a private key.",
    );
  }

  const owner = isRecord(value.owner) ? value.owner : null;
  const ownerId = readOpaqueGithubIdentifier(owner?.id, "owner ID");
  const ownerLogin = validateGithubLogin(owner?.login, "owner login");
  const ownerType = owner?.type;
  if (ownerType !== "User" && ownerType !== "Organization") {
    throw new GithubIntegrationValidationError("GitHub App owner type is invalid.");
  }
  return {
    githubAppId,
    slug,
    ownerId,
    ownerLogin,
    ownerType,
    privateKeyPem,
  };
}

export function completeManifestAttempt(
  database: SqliteDatabase,
  attemptId: string,
  now = new Date(),
): GithubAppRegistration {
  const timestamp = toIso(now);
  // The manifest attempt ID is Redrive-generated. Deriving the reference here
  // prevents a caller from persisting a non-recoverable or unrelated path.
  const privateKeyRef = manifestPrivateKeyReference(attemptId);
  return database.transaction(() => {
    const row = database.get<Record<string, unknown>>(
      `SELECT id, target_type, owner_login, status, app_registration_id,
              remote_github_app_id, remote_slug, remote_owner_id,
              remote_owner_login, remote_owner_type, private_key_sha256
         FROM github_manifest_attempts WHERE id = ?`,
      [attemptId],
    );
    if (row === undefined) throw new Error("GitHub manifest attempt was not found.");
    const status = readRowText(row, "status");
    if (status !== MANIFEST_ATTEMPT_EXCHANGING) {
      throw new Error("GitHub manifest attempt is no longer claimable.");
    }
    if (readRowNullableText(row, "app_registration_id") !== null) {
      throw new Error("GitHub manifest attempt has a conflicting registration.");
    }
    const fields = [
      readCheckpointNullableText(row, "remote_github_app_id"),
      readCheckpointNullableText(row, "remote_slug"),
      readCheckpointNullableText(row, "remote_owner_id"),
      readCheckpointNullableText(row, "remote_owner_login"),
      readCheckpointNullableText(row, "remote_owner_type"),
      readCheckpointNullableText(row, "private_key_sha256"),
    ];
    if (fields.some((value) => value === null)) {
      throw new Error("GitHub manifest conversion checkpoint is incomplete.");
    }
    let checkpoint: ManifestConversionCheckpoint;
    try {
      checkpoint = validateCheckpoint({
        githubAppId: fields[0] as string,
        slug: fields[1] as string,
        ownerId: fields[2] as string,
        ownerLogin: fields[3] as string,
        ownerType: fields[4],
        privateKeySha256: fields[5],
      });
    } catch {
      throw new Error("GitHub manifest conversion checkpoint is invalid.");
    }
    const targetType = readRowText(row, "target_type") as ManifestTargetType;
    const targetOwnerLogin = readRowNullableText(row, "owner_login");
    if (
      !checkpointMatchesTarget(
        { targetType, ownerLogin: targetOwnerLogin },
        checkpoint,
      )
    ) {
      throw new Error("GitHub App owner did not match the state-bound target.");
    }

    const registrationId = randomUUID();
    database.run(
      `
        INSERT INTO github_app_registrations (
          id, github_app_id, slug, owner_id, owner_login, owner_type,
          private_key_ref, created_at, updated_at
        ) VALUES (
          @id, @githubAppId, @slug, @ownerId, @ownerLogin, @ownerType,
          @privateKeyRef, @createdAt, @updatedAt
        )
      `,
      {
        id: registrationId,
        githubAppId: checkpoint.githubAppId,
        slug: checkpoint.slug,
        ownerId: checkpoint.ownerId,
        ownerLogin: checkpoint.ownerLogin,
        ownerType: checkpoint.ownerType,
        privateKeyRef,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    );
    const result = database.run(
      `UPDATE github_manifest_attempts
          SET status = ?, app_registration_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = ? AND app_registration_id IS NULL`,
      [MANIFEST_ATTEMPT_COMPLETED, registrationId, timestamp, timestamp, attemptId, MANIFEST_ATTEMPT_EXCHANGING],
    );
    if (result.changes !== 1) {
      throw new Error("GitHub manifest attempt is no longer claimable.");
    }
    const registrationRow = database.get<Record<string, unknown>>(
      `SELECT id, github_app_id, slug, owner_id, owner_login, owner_type,
              private_key_ref, created_at, updated_at
         FROM github_app_registrations WHERE id = ?`,
      [registrationId],
    );
    if (registrationRow === undefined) throw new Error("GitHub App registration could not be read back.");
    return mapRegistration(registrationRow);
  }, "immediate");
}

export function getGithubAppRegistration(
  database: SqliteDatabase,
  registrationId: string,
): GithubAppRegistration | null {
  const row = database.get<Record<string, unknown>>(
    `SELECT id, github_app_id, slug, owner_id, owner_login, owner_type,
            private_key_ref, created_at, updated_at
       FROM github_app_registrations WHERE id = ?`,
    [registrationId],
  );
  return row === undefined ? null : mapRegistration(row);
}

export function createInstallationAttempt(
  database: SqliteDatabase,
  registration: GithubAppRegistration,
  now = new Date(),
): CreatedInstallationAttempt {
  const timestamp = toIso(now);
  const expiresAt = new Date(now.getTime() + INSTALLATION_ATTEMPT_TTL_MS).toISOString();
  const attemptId = randomUUID();
  const state = makeStateToken();
  const githubInstallationUrl =
    `https://github.com/apps/${encodeURIComponent(registration.slug)}/installations/new?state=${encodeURIComponent(state)}`;

  database.run(
    `
      INSERT INTO github_installation_attempts (
        id, state_hash, app_registration_id, status, expires_at,
        created_at, updated_at
      ) VALUES (
        @id, @stateHash, @appRegistrationId, @status, @expiresAt,
        @createdAt, @updatedAt
      )
    `,
    {
      id: attemptId,
      stateHash: hashToken(state),
      appRegistrationId: registration.id,
      status: INSTALLATION_ATTEMPT_PENDING,
      expiresAt,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  );
  const row = database.get<Record<string, unknown>>(
    `SELECT id, app_registration_id, status, expires_at, claimed_at,
            installation_id, recovery_reason, created_at, updated_at,
            completed_at
       FROM github_installation_attempts WHERE id = ?`,
    [attemptId],
  );
  if (row === undefined) throw new Error("GitHub installation attempt could not be read back.");
  return {
    attempt: mapInstallationAttempt(row),
    state,
    githubInstallationUrl,
  };
}

function getInstallationAttemptByStateHash(
  database: SqliteDatabase,
  state: string,
): InstallationAttempt | null {
  if (typeof state !== "string" || state.length < 32 || state.length > 256) return null;
  const stateHash = hashToken(state);
  const row = database.get<Record<string, unknown>>(
    `SELECT id, app_registration_id, status, expires_at, claimed_at,
            installation_id, recovery_reason, created_at, updated_at,
            completed_at, state_hash
       FROM github_installation_attempts WHERE state_hash = ?`,
    [stateHash],
  );
  if (row === undefined || !timingSafeStringEqual(readRowText(row, "state_hash"), stateHash)) {
    return null;
  }
  return mapInstallationAttempt(row);
}

export type InstallationClaim =
  | { kind: "claimed"; attempt: InstallationAttempt }
  | { kind: "completed"; attempt: InstallationAttempt }
  | { kind: "recovery"; attempt: InstallationAttempt };

export function claimInstallationAttempt(
  database: SqliteDatabase,
  state: string,
  now = new Date(),
): InstallationClaim {
  const result = database.transaction(() => {
    const attempt = getInstallationAttemptByStateHash(database, state);
    if (attempt === null) {
      throw new GithubIntegrationStateError(
        "INVALID_STATE",
        "The GitHub installation state is invalid.",
      );
    }
    if (attempt.status === INSTALLATION_ATTEMPT_COMPLETED) {
      return { kind: "completed", attempt } as const;
    }
    if (attempt.status === INSTALLATION_ATTEMPT_RECOVERY_REQUIRED) {
      return { kind: "recovery", attempt } as const;
    }
    if (attempt.status === INSTALLATION_ATTEMPT_VERIFYING) {
      const claimedAt = attempt.claimedAt === null ? NaN : Date.parse(attempt.claimedAt);
      const expiresAt = Date.parse(attempt.expiresAt);
      const claimIsStale =
        !Number.isFinite(claimedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= now.getTime() ||
        now.getTime() - claimedAt >= INSTALLATION_CLAIM_STALE_AFTER_MS;
      if (claimIsStale) {
        const recoveryReason = "Installation verification claim became stale; manual recovery is required.";
        const recovered = database.run(
          `UPDATE github_installation_attempts
              SET status = ?, recovery_reason = ?, updated_at = ?
            WHERE id = ? AND status = ?`,
          [
            INSTALLATION_ATTEMPT_RECOVERY_REQUIRED,
            recoveryReason,
            now.toISOString(),
            attempt.id,
            INSTALLATION_ATTEMPT_VERIFYING,
          ],
        );
        if (recovered.changes === 1) {
          const recoveredAttempt = getInstallationAttemptByStateHash(database, state);
          if (recoveredAttempt === null) throw new Error("Stale installation claim could not be read back.");
          return { kind: "recovery", attempt: recoveredAttempt } as const;
        }
      }
      throw new GithubIntegrationStateError(
        "ALREADY_CLAIMED",
        "The GitHub installation attempt is already being verified.",
      );
    }
    const expiresAt = Date.parse(attempt.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      database.run(
        `UPDATE github_installation_attempts
            SET status = ?, recovery_reason = ?, updated_at = ?
          WHERE id = ? AND status = ?`,
        [
          INSTALLATION_ATTEMPT_RECOVERY_REQUIRED,
          "Installation attempt expired before verification.",
          now.toISOString(),
          attempt.id,
          INSTALLATION_ATTEMPT_PENDING,
        ],
      );
      return { kind: "expired" } as const;
    }
    const updatedAt = now.toISOString();
    const update = database.run(
      `UPDATE github_installation_attempts
          SET status = ?, claimed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?`,
      [
        INSTALLATION_ATTEMPT_VERIFYING,
        updatedAt,
        updatedAt,
        attempt.id,
        INSTALLATION_ATTEMPT_PENDING,
      ],
    );
    if (update.changes !== 1) {
      throw new GithubIntegrationStateError(
        "ALREADY_CLAIMED",
        "The GitHub installation attempt is already being verified.",
      );
    }
    const row = database.get<Record<string, unknown>>(
      `SELECT id, app_registration_id, status, expires_at, claimed_at,
              installation_id, recovery_reason, created_at, updated_at,
              completed_at
         FROM github_installation_attempts WHERE id = ?`,
      [attempt.id],
    );
    if (row === undefined) throw new Error("Installation claim could not be read back.");
    return { kind: "claimed", attempt: mapInstallationAttempt(row) } as const;
  }, "immediate");

  if (result.kind === "expired") {
    throw new GithubIntegrationStateError(
      "EXPIRED_STATE",
      "The GitHub installation state has expired.",
    );
  }
  return result;
}
export function markInstallationAttemptRecovery(
  database: SqliteDatabase,
  attemptId: string,
  reason = "GitHub installation verification requires recovery.",
): void {
  database.run(
    `UPDATE github_installation_attempts
        SET status = ?, recovery_reason = ?, updated_at = ?
      WHERE id = ? AND status = ?`,
    [
      INSTALLATION_ATTEMPT_RECOVERY_REQUIRED,
      reason.slice(0, 512),
      new Date().toISOString(),
      attemptId,
      INSTALLATION_ATTEMPT_VERIFYING,
    ],
  );
}

export function completeInstallationAttempt(
  database: SqliteDatabase,
  attemptId: string,
  installation: Omit<GithubInstallation, "createdAt" | "updatedAt">,
  now = new Date(),
): GithubInstallation {
  const timestamp = toIso(now);
  return database.transaction(() => {
    const existing = database.get<Record<string, unknown>>(
      `SELECT installation_id, app_registration_id, account_id, account_login,
              account_type, repository_selection, last_verified_at, created_at,
              updated_at
         FROM github_installations WHERE installation_id = ?`,
      [installation.installationId],
    );
    let createdAt = timestamp;
    if (existing !== undefined) {
      const existingInstallation = mapInstallation(existing);
      if (existingInstallation.appRegistrationId !== installation.appRegistrationId) {
        throw new Error("GitHub installation belongs to a different App.");
      }
      createdAt = existingInstallation.createdAt;
    }
    database.run(
      `
        INSERT INTO github_installations (
          installation_id, app_registration_id, account_id, account_login,
          account_type, repository_selection, last_verified_at, created_at,
          updated_at
        ) VALUES (
          @installationId, @appRegistrationId, @accountId, @accountLogin,
          @accountType, @repositorySelection, @lastVerifiedAt, @createdAt,
          @updatedAt
        )
        ON CONFLICT (installation_id) DO UPDATE SET
          app_registration_id = excluded.app_registration_id,
          account_id = excluded.account_id,
          account_login = excluded.account_login,
          account_type = excluded.account_type,
          repository_selection = excluded.repository_selection,
          last_verified_at = excluded.last_verified_at,
          updated_at = excluded.updated_at
      `,
      {
        installationId: installation.installationId,
        appRegistrationId: installation.appRegistrationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: installation.repositorySelection,
        lastVerifiedAt: installation.lastVerifiedAt,
        createdAt,
        updatedAt: timestamp,
      },
    );
    const updated = database.run(
      `UPDATE github_installation_attempts
          SET status = ?, installation_id = ?, completed_at = ?, updated_at = ?
        WHERE id = ? AND status = ?`,
      [
        INSTALLATION_ATTEMPT_COMPLETED,
        installation.installationId,
        timestamp,
        timestamp,
        attemptId,
        INSTALLATION_ATTEMPT_VERIFYING,
      ],
    );
    if (updated.changes !== 1) {
      throw new Error("GitHub installation attempt is no longer claimable.");
    }
    const row = database.get<Record<string, unknown>>(
      `SELECT installation_id, app_registration_id, account_id, account_login,
              account_type, repository_selection, last_verified_at, created_at,
              updated_at
         FROM github_installations WHERE installation_id = ?`,
      [installation.installationId],
    );
    if (row === undefined) throw new Error("GitHub installation could not be read back.");
    return mapInstallation(row);
  }, "immediate");
}

export function getInstallation(
  database: SqliteDatabase,
  installationId: string,
): GithubInstallation | null {
  const row = database.get<Record<string, unknown>>(
    `SELECT installation_id, app_registration_id, account_id, account_login,
            account_type, repository_selection, last_verified_at, created_at,
            updated_at
       FROM github_installations WHERE installation_id = ?`,
    [installationId],
  );
  return row === undefined ? null : mapInstallation(row);
}

export function getInstallationAttemptById(
  database: SqliteDatabase,
  attemptId: string,
): InstallationAttempt | null {
  const row = database.get<Record<string, unknown>>(
    `SELECT id, app_registration_id, status, expires_at, claimed_at,
            installation_id, recovery_reason, created_at, updated_at,
            completed_at
       FROM github_installation_attempts WHERE id = ?`,
    [attemptId],
  );
  return row === undefined ? null : mapInstallationAttempt(row);
}

export function listApplicationConnections(
  database: SqliteDatabase,
): import("@/domain/github-integration").ApplicationConnection[] {
  const rows = database.all<Record<string, unknown>>(
    `SELECT id, provider, github_installation_id, repository_id,
            repository_full_name, webhook_id, webhook_target_display, state,
            created_at, updated_at
       FROM application_connections
      ORDER BY created_at DESC, id DESC`,
  );
  return rows.map((row) => {
    const state = readRowText(row, "state");
    if (state !== APPLICATION_CONNECTION_READY || readRowText(row, "provider") !== GITHUB_PROVIDER) {
      throw new Error("Application connection row has an invalid state.");
    }
    return {
      id: readRowText(row, "id"),
      provider: GITHUB_PROVIDER,
      githubInstallationId: readRowText(row, "github_installation_id"),
      repositoryId: readRowText(row, "repository_id"),
      repositoryFullName: readRowText(row, "repository_full_name"),
      webhookId: readRowText(row, "webhook_id"),
      webhookTargetDisplay: readRowText(row, "webhook_target_display"),
      state: APPLICATION_CONNECTION_READY,
      createdAt: readRowText(row, "created_at"),
      updatedAt: readRowText(row, "updated_at"),
    };
  });
}
