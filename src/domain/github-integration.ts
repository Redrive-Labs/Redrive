import { timingSafeEqual } from "node:crypto";

export const GITHUB_PROVIDER = "github" as const;
export const MANIFEST_ATTEMPT_PENDING = "PENDING" as const;
export const MANIFEST_ATTEMPT_EXCHANGING = "EXCHANGING" as const;
export const MANIFEST_ATTEMPT_COMPLETED = "COMPLETED" as const;
export const MANIFEST_ATTEMPT_RECOVERY_REQUIRED = "RECOVERY_REQUIRED" as const;
export type ManifestAttemptStatus =
  | typeof MANIFEST_ATTEMPT_PENDING
  | typeof MANIFEST_ATTEMPT_EXCHANGING
  | typeof MANIFEST_ATTEMPT_COMPLETED
  | typeof MANIFEST_ATTEMPT_RECOVERY_REQUIRED;

export const INSTALLATION_ATTEMPT_PENDING = "PENDING" as const;
export const INSTALLATION_ATTEMPT_VERIFYING = "VERIFYING" as const;
export const INSTALLATION_ATTEMPT_COMPLETED = "COMPLETED" as const;
export const INSTALLATION_ATTEMPT_RECOVERY_REQUIRED = "RECOVERY_REQUIRED" as const;
export type InstallationAttemptStatus =
  | typeof INSTALLATION_ATTEMPT_PENDING
  | typeof INSTALLATION_ATTEMPT_VERIFYING
  | typeof INSTALLATION_ATTEMPT_COMPLETED
  | typeof INSTALLATION_ATTEMPT_RECOVERY_REQUIRED;

export const APPLICATION_CONNECTION_READY = "READY" as const;
export type ApplicationConnectionState = typeof APPLICATION_CONNECTION_READY;

export type GithubAccountType = "User" | "Organization";
export type ManifestTargetType = "personal" | "organization";

export interface GithubAppRegistration {
  id: string;
  githubAppId: string;
  slug: string;
  ownerId: string;
  ownerLogin: string;
  ownerType: GithubAccountType;
  privateKeyRef: string;
  createdAt: string;
  updatedAt: string;
}

export interface GithubInstallation {
  installationId: string;
  appRegistrationId: string;
  accountId: string;
  accountLogin: string;
  accountType: GithubAccountType;
  repositorySelection: "all" | "selected";
  lastVerifiedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApplicationConnection {
  id: string;
  provider: typeof GITHUB_PROVIDER;
  githubInstallationId: string;
  repositoryId: string;
  repositoryFullName: string;
  webhookId: string;
  webhookTargetDisplay: string;
  state: ApplicationConnectionState;
  createdAt: string;
  updatedAt: string;
}

export interface GithubRepositoryChoice {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

export interface GithubWebhookChoice {
  id: string;
  name: string;
  targetDisplay: string;
  active: boolean;
  events: string[];
}

export class GithubIntegrationValidationError extends Error {
  readonly issues: Record<string, string>;

  constructor(message: string, issues: Record<string, string> = {}) {
    super(message);
    this.name = "GithubIntegrationValidationError";
    this.issues = issues;
  }
}

export class GithubIntegrationStateError extends Error {
  readonly code:
    | "INVALID_STATE"
    | "EXPIRED_STATE"
    | "ALREADY_CLAIMED"
    | "RECOVERY_REQUIRED"
    | "NOT_FOUND";

  constructor(
    code: GithubIntegrationStateError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GithubIntegrationStateError";
    this.code = code;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readOpaqueGithubIdentifier(
  value: unknown,
  field: string,
): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  // The lossless REST decoder turns unsafe integer literals into strings. A
  // safe integer is accepted only for compatibility with GitHub responses that
  // contain ordinary-sized IDs; it is immediately converted at this boundary
  // and is never stored or sent back as a JavaScript number.
  if (typeof value === "number" && Number.isSafeInteger(value)) {
    return String(value);
  }

  throw new GithubIntegrationValidationError(
    `GitHub ${field} must be a non-empty opaque identifier.`,
    { [field]: "Must be a non-empty identifier." },
  );
}

export function readRequiredText(
  value: unknown,
  field: string,
  maxLength = 1024,
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new GithubIntegrationValidationError(
      `GitHub ${field} must be a non-empty string.`,
      { [field]: "Must be a non-empty string." },
    );
  }
  if (value.length > maxLength) {
    throw new GithubIntegrationValidationError(
      `GitHub ${field} is too long.`,
      { [field]: `Must be at most ${maxLength} characters.` },
    );
  }
  return value;
}

const GITHUB_LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export function validateGithubLogin(value: unknown, field = "ownerLogin"): string {
  if (typeof value !== "string" || !GITHUB_LOGIN_PATTERN.test(value)) {
    throw new GithubIntegrationValidationError(
      `GitHub ${field} is invalid.`,
      { [field]: "Use a valid GitHub login." },
    );
  }
  return value;
}

function normalizeGithubLogin(login: string): string {
  // GitHub logins use the validated ASCII grammar above. Normalize only ASCII
  // A-Z; do not apply Unicode case folding to arbitrary input.
  return login.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 32),
  );
}

export function githubLoginsEqual(left: unknown, right: unknown): boolean {
  return (
    normalizeGithubLogin(validateGithubLogin(left, "GitHub login")) ===
    normalizeGithubLogin(validateGithubLogin(right, "GitHub login"))
  );
}

export function parseManifestTarget(input: unknown): {
  targetType: ManifestTargetType;
  ownerLogin: string | null;
} {
  if (!isRecord(input)) {
    throw new GithubIntegrationValidationError("Manifest target must be an object.");
  }

  const rawTarget = input.targetType ?? input.target;
  if (rawTarget !== "personal" && rawTarget !== "organization") {
    throw new GithubIntegrationValidationError(
      "Manifest target must be personal or organization.",
      { targetType: "Choose personal or organization." },
    );
  }

  if (rawTarget === "personal") {
    return { targetType: rawTarget, ownerLogin: null };
  }

  return {
    targetType: rawTarget,
    ownerLogin: validateGithubLogin(input.ownerLogin),
  };
}

export function sanitizeWebhookTarget(value: unknown): string {
  const raw = readRequiredText(value, "webhook URL", 4096);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new GithubIntegrationValidationError("GitHub webhook URL is invalid.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new GithubIntegrationValidationError(
      "GitHub webhook URL must use HTTP or HTTPS.",
    );
  }
  if (parsed.hostname.length === 0) {
    throw new GithubIntegrationValidationError(
      "GitHub webhook URL must include a host.",
    );
  }

  return `${parsed.protocol}//${parsed.host}${parsed.pathname || "/"}`;
}

export function timingSafeStringEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}
