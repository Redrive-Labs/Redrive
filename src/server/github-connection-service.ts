import { randomUUID } from "node:crypto";
import {
  APPLICATION_CONNECTION_READY,
  GITHUB_PROVIDER,
  isRecord,
  readOpaqueGithubIdentifier,
  readRequiredText,
  sanitizeWebhookTarget,
  type ApplicationConnection,
  type GithubInstallation,
  type GithubAppRegistration,
  type GithubRepositoryChoice,
  type GithubWebhookChoice,
} from "@/domain/github-integration";
import { createGithubAppJwt } from "@/server/github-app-jwt";
import {
  getGithubAppRegistration,
  getInstallation,
} from "@/server/github-app-service";
import type { SqliteDatabase } from "@/server/database";
import { GithubRestError, type GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";

export class GithubConnectionError extends Error {
  readonly code:
    | "NOT_FOUND"
    | "INVALID_INPUT"
    | "NOT_ACCESSIBLE"
    | "REMOTE_INVALID"
    | "RECOVERY_REQUIRED";

  constructor(
    code: GithubConnectionError["code"],
    message: string,
  ) {
    super(message);
    this.name = "GithubConnectionError";
    this.code = code;
  }
}

export interface GithubInstallationContext {
  installation: GithubInstallation;
  registration: GithubAppRegistration;
}

export interface InstallationAccessToken {
  token: string;
  expiresAt: string | null;
}

function requireOpaqueInput(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 1024) {
    throw new GithubConnectionError(
      "INVALID_INPUT",
      `GitHub ${field} must be a non-empty identifier.`,
    );
  }
  return value;
}

function readRecord(value: unknown, message: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GithubConnectionError("REMOTE_INVALID", message);
  }
  return value;
}

function readRemoteText(
  record: Record<string, unknown>,
  key: string,
  maxLength = 1024,
  label = key,
): string {
  try {
    return readRequiredText(record[key], label, maxLength);
  } catch {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      `GitHub response field ${label} is invalid.`,
    );
  }
}

function readRemoteId(
  record: Record<string, unknown>,
  key: string,
  label = key,
): string {
  try {
    return readOpaqueGithubIdentifier(record[key], label);
  } catch {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      `GitHub response field ${label} is invalid.`,
    );
  }
}

export function parseInstallationAccessToken(
  value: unknown,
): InstallationAccessToken {
  const record = readRecord(value, "GitHub installation token response is invalid.");
  const token = readRemoteText(record, "token", 16 * 1024);
  const expiresAt =
    record.expires_at === undefined || record.expires_at === null
      ? null
      : readRemoteText(record, "expires_at", 128);
  return { token, expiresAt };
}

export function parseGithubInstallation(
  value: unknown,
  expectedInstallationId: string,
  expectedAppId: string,
): Omit<GithubInstallation, "createdAt" | "updatedAt" | "lastVerifiedAt"> {
  const record = readRecord(value, "GitHub installation response is invalid.");
  const installationId = readRemoteId(record, "id", "installation ID");
  if (installationId !== expectedInstallationId) {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub installation identity does not match the callback.",
    );
  }
  const appId = readRemoteId(record, "app_id", "app ID");
  if (appId !== expectedAppId) {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub installation belongs to a different App.",
    );
  }
  const account = readRecord(record.account, "GitHub installation account is invalid.");
  const accountId = readRemoteId(account, "id", "account ID");
  const accountLogin = readRemoteText(account, "login", 255, "account login");
  const accountType = account.type;
  if (accountType !== "User" && accountType !== "Organization") {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub installation account type is invalid.",
    );
  }
  const repositorySelection = record.repository_selection;
  if (repositorySelection !== "all" && repositorySelection !== "selected") {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub installation repository selection is invalid.",
    );
  }

  return {
    installationId,
    appRegistrationId: "", // Filled by the callback from the state-bound attempt.
    accountId,
    accountLogin,
    accountType,
    repositorySelection,
  };
}

export function parseGithubRepository(value: unknown): GithubRepositoryChoice {
  const record = readRecord(value, "GitHub repository response is invalid.");
  const id = readRemoteId(record, "id", "repository ID");
  const fullName = readRemoteText(record, "full_name", 511, "repository full name");
  if (!/^[^/\s]{1,255}\/[^/\s]{1,255}$/.test(fullName)) {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub repository full name is invalid.",
    );
  }
  if (typeof record.private !== "boolean") {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub repository visibility is invalid.",
    );
  }
  const defaultBranch =
    record.default_branch === null || record.default_branch === undefined
      ? null
      : readRemoteText(record, "default_branch", 255, "default branch");
  return { id, fullName, private: record.private, defaultBranch };
}

export function parseGithubWebhook(value: unknown): GithubWebhookChoice {
  const record = readRecord(value, "GitHub webhook response is invalid.");
  const id = readRemoteId(record, "id", "webhook ID");
  const name = readRemoteText(record, "name", 255, "webhook name");
  if (typeof record.active !== "boolean") {
    throw new GithubConnectionError("REMOTE_INVALID", "GitHub webhook active flag is invalid.");
  }
  if (!Array.isArray(record.events) || !record.events.every((event) => typeof event === "string")) {
    throw new GithubConnectionError("REMOTE_INVALID", "GitHub webhook events are invalid.");
  }
  const config = readRecord(record.config, "GitHub webhook config is invalid.");
  let targetDisplay: string;
  try {
    targetDisplay = sanitizeWebhookTarget(config.url);
  } catch {
    throw new GithubConnectionError(
      "REMOTE_INVALID",
      "GitHub webhook does not expose a safe HTTP target.",
    );
  }
  return {
    id,
    name,
    targetDisplay,
    active: record.active,
    events: record.events,
  };
}

export interface GithubWebhookDeliveryChoice {
  id: string;
  guid: string | null;
  status: string | null;
  statusCode: number | null;
  deliveredAt: string | null;
  event: string | null;
  redelivery: boolean | null;
}

function readNullableText(
  record: Record<string, unknown>,
  field: string,
  maxLength = 1024,
): string | null {
  if (record[field] === undefined || record[field] === null) return null;
  return readRemoteText(record, field, maxLength);
}

function readNullableStatusCode(
  record: Record<string, unknown>,
): number | null {
  const value = record.status_code;
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new GithubConnectionError("REMOTE_INVALID", "GitHub delivery status code is invalid.");
  }
  return value;
}

export function parseGithubWebhookDelivery(
  value: unknown,
): GithubWebhookDeliveryChoice {
  const record = readRecord(value, "GitHub webhook delivery response is invalid.");
  return {
    id: readRemoteId(record, "id", "delivery ID"),
    guid: readNullableText(record, "guid", 255),
    status: readNullableText(record, "status", 255),
    statusCode: readNullableStatusCode(record),
    deliveredAt: readNullableText(record, "delivered_at", 128),
    event: readNullableText(record, "event", 255),
    redelivery:
      record.redelivery === undefined || record.redelivery === null
        ? null
        : typeof record.redelivery === "boolean"
          ? record.redelivery
          : (() => {
              throw new GithubConnectionError("REMOTE_INVALID", "GitHub delivery redelivery flag is invalid.");
            })(),
  };
}

export function isFailedGithubWebhookDelivery(
  delivery: GithubWebhookDeliveryChoice,
): boolean {
  if (delivery.statusCode !== null) return delivery.statusCode >= 400;
  return delivery.status !== null && /fail|error|invalid/i.test(delivery.status);
}

export function createGithubInstallationAccessService(options: {
  database: SqliteDatabase;
  api: GithubApi;
  secretStore: SecretStore;
}) {
  const { database, api, secretStore } = options;

  function getContext(installationIdInput: unknown): GithubInstallationContext {
    const installationId = requireOpaqueInput(installationIdInput, "installation ID");
    const installation = getInstallation(database, installationId);
    if (installation === null) {
      throw new GithubConnectionError("NOT_FOUND", "GitHub installation was not found.");
    }
    const registration = getGithubAppRegistration(database, installation.appRegistrationId);
    if (registration === null) {
      throw new GithubConnectionError("RECOVERY_REQUIRED", "GitHub App registration is unavailable.");
    }
    return { installation, registration };
  }

  function appJwt(registration: GithubAppRegistration): string {
    let privateKey: string;
    try {
      privateKey = secretStore.readPrivateKey(registration.privateKeyRef);
    } catch {
      throw new GithubConnectionError(
        "RECOVERY_REQUIRED",
        "GitHub App credentials require recovery.",
      );
    }
    try {
      return createGithubAppJwt({ appId: registration.githubAppId, privateKey });
    } catch {
      throw new GithubConnectionError(
        "RECOVERY_REQUIRED",
        "GitHub App credentials require recovery.",
      );
    }
  }

  async function createInstallationAccessToken(
    context: GithubInstallationContext,
    repositoryIds?: string[],
  ): Promise<InstallationAccessToken> {
    const jwt = appJwt(context.registration);
    let response: unknown;
    try {
      response = await api.createInstallationToken(
        context.installation.installationId,
        jwt,
        repositoryIds,
      );
    } catch (error) {
      if (error instanceof GithubRestError) {
        throw new GithubConnectionError("NOT_ACCESSIBLE", "GitHub installation access could not be created.");
      }
      throw error;
    }
    try {
      return parseInstallationAccessToken(response);
    } catch {
      throw new GithubConnectionError("REMOTE_INVALID", "GitHub installation token response is invalid.");
    }
  }

  async function listRepositories(installationId: unknown): Promise<GithubRepositoryChoice[]> {
    const context = getContext(installationId);
    const credential = await createInstallationAccessToken(context);
    let response: unknown[];
    try {
      response = await api.listInstallationRepositories(credential.token);
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "GitHub repositories could not be discovered.");
    }
    const repositories: GithubRepositoryChoice[] = [];
    const seen = new Set<string>();
    for (const item of response) {
      const repository = parseGithubRepository(item);
      if (seen.has(repository.id)) continue;
      seen.add(repository.id);
      repositories.push(repository);
    }
    return repositories;
  }

  async function fetchAuthoritativeRepository(
    context: GithubInstallationContext,
    repositoryId: string,
  ): Promise<{ repository: GithubRepositoryChoice; credential: InstallationAccessToken }> {
    const credential = await createInstallationAccessToken(context, [repositoryId]);
    let response: unknown[];
    try {
      // GitHub exposes the installation repository collection, rather than a
      // generic repository-by-ID GET endpoint. The repository-scoped token
      // means this authoritative re-fetch is still limited to the selection.
      response = await api.listInstallationRepositories(credential.token);
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The selected repository is not accessible to this installation.");
    }
    const matching = response
      .map((item) => parseGithubRepository(item))
      .filter((repository) => repository.id === repositoryId);
    if (matching.length !== 1) {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The selected repository is not accessible to this installation.");
    }
    return { repository: matching[0], credential };
  }

  async function listWebhooks(
    installationIdInput: unknown,
    repositoryIdInput: unknown,
  ): Promise<{ repository: GithubRepositoryChoice; webhooks: GithubWebhookChoice[] }> {
    const context = getContext(installationIdInput);
    const repositoryId = requireOpaqueInput(repositoryIdInput, "repository ID");
    const { repository, credential } = await fetchAuthoritativeRepository(context, repositoryId);
    let response: unknown;
    try {
      response = await api.listRepositoryHooks(repository.fullName, credential.token);
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "Repository webhooks could not be discovered.");
    }
    if (!Array.isArray(response)) {
      throw new GithubConnectionError("REMOTE_INVALID", "GitHub webhooks response is invalid.");
    }
    const webhooks: GithubWebhookChoice[] = [];
    const seen = new Set<string>();
    for (const item of response) {
      const webhook = parseGithubWebhook(item);
      if (seen.has(webhook.id)) continue;
      seen.add(webhook.id);
      webhooks.push(webhook);
    }
    return { repository, webhooks };
  }

  async function createConnection(input: {
    installationId: unknown;
    repositoryId: unknown;
    webhookId: unknown;
  }): Promise<{ connection: ApplicationConnection; created: boolean }> {
    const context = getContext(input.installationId);
    const repositoryId = requireOpaqueInput(input.repositoryId, "repository ID");
    const webhookId = requireOpaqueInput(input.webhookId, "webhook ID");
    const { repository, credential } = await fetchAuthoritativeRepository(context, repositoryId);
    let response: unknown;
    try {
      response = await api.getRepositoryHook(repository.fullName, webhookId, credential.token);
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The selected webhook is not accessible for this repository.");
    }
    const webhook = parseGithubWebhook(response);
    if (webhook.id !== webhookId) {
      throw new GithubConnectionError("REMOTE_INVALID", "GitHub webhook identity does not match the selection.");
    }

    const now = new Date().toISOString();
    const connectionId = randomUUID();
    const insertion = database.run(
      `
        INSERT INTO application_connections (
          id, provider, github_installation_id, repository_id,
          repository_full_name, webhook_id, webhook_target_display, state,
          created_at, updated_at
        ) VALUES (
          @id, @provider, @installationId, @repositoryId,
          @repositoryFullName, @webhookId, @webhookTargetDisplay, @state,
          @createdAt, @updatedAt
        )
        ON CONFLICT (provider, repository_id, webhook_id) DO NOTHING
      `,
      {
        id: connectionId,
        provider: GITHUB_PROVIDER,
        installationId: context.installation.installationId,
        repositoryId: repository.id,
        repositoryFullName: repository.fullName,
        webhookId: webhook.id,
        webhookTargetDisplay: webhook.targetDisplay,
        state: APPLICATION_CONNECTION_READY,
        createdAt: now,
        updatedAt: now,
      },
    );
    const row = database.get<Record<string, unknown>>(
      `SELECT id, provider, github_installation_id, repository_id,
              repository_full_name, webhook_id, webhook_target_display, state,
              created_at, updated_at
         FROM application_connections
        WHERE provider = ? AND repository_id = ? AND webhook_id = ?`,
      [GITHUB_PROVIDER, repository.id, webhook.id],
    );
    if (row === undefined) throw new Error("Application connection could not be read back.");
    return {
      connection: mapConnection(row),
      created: insertion.changes === 1,
    };
  }

  return {
    getContext,
    createInstallationAccessToken,
    listRepositories,
    listWebhooks,
    createConnection,
  };
}

function mapConnection(row: Record<string, unknown>): ApplicationConnection {
  const provider = row.provider;
  const state = row.state;
  if (provider !== GITHUB_PROVIDER || state !== APPLICATION_CONNECTION_READY) {
    throw new Error("Application connection row has an invalid provider or state.");
  }
  const text = (field: string): string => {
    const value = row[field];
    if (typeof value !== "string") throw new Error(`Application connection row has an invalid ${field}.`);
    return value;
  };
  return {
    id: text("id"),
    provider: GITHUB_PROVIDER,
    githubInstallationId: text("github_installation_id"),
    repositoryId: text("repository_id"),
    repositoryFullName: text("repository_full_name"),
    webhookId: text("webhook_id"),
    webhookTargetDisplay: text("webhook_target_display"),
    state: APPLICATION_CONNECTION_READY,
    createdAt: text("created_at"),
    updatedAt: text("updated_at"),
  };
}

export function getApplicationConnection(
  database: SqliteDatabase,
  connectionId: string,
): ApplicationConnection | null {
  const row = database.get<Record<string, unknown>>(
    `SELECT id, provider, github_installation_id, repository_id,
            repository_full_name, webhook_id, webhook_target_display, state,
            created_at, updated_at
       FROM application_connections WHERE id = ?`,
    [connectionId],
  );
  return row === undefined ? null : mapConnection(row);
}

export function getConnectionForIncident(
  database: SqliteDatabase,
  connectionId: string,
): ApplicationConnection {
  const connection = getApplicationConnection(database, connectionId);
  if (connection === null) {
    throw new GithubConnectionError(
      "NOT_FOUND",
      "Application connection was not found.",
    );
  }
  return connection;
}
