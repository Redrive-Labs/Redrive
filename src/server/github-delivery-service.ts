import {
  getApplicationConnection,
  type GithubInstallationContext,
  createGithubInstallationAccessService,
  parseGithubRepository,
  parseGithubWebhook,
  isFailedGithubWebhookDelivery,
  parseGithubWebhookDelivery,
  type GithubWebhookDeliveryChoice,
  GithubConnectionError,
} from "@/server/github-connection-service";
import type { SqliteDatabase } from "@/server/database";
import type { GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";
import { createIncidentService } from "@/server/incident-service";

export interface FailedDeliveryChoice extends GithubWebhookDeliveryChoice {
  status: string;
}

// This symbol is intentionally module-private. A raw request object cannot
// satisfy VerifiedGithubFailedDelivery without bypassing the type boundary;
// only this module creates the value after authoritative GitHub checks.
const verifiedDeliveryBrand = Symbol("verified-github-failed-delivery");

export interface VerifiedGithubFailedDelivery extends FailedDeliveryChoice {
  readonly provider: "github";
  readonly connectionId: string;
  readonly repositoryId: string;
  readonly webhookId: string;
  readonly [verifiedDeliveryBrand]: true;
}

function makeVerifiedGithubFailedDelivery(
  connection: NonNullable<ReturnType<typeof getApplicationConnection>>,
  delivery: FailedDeliveryChoice,
): VerifiedGithubFailedDelivery {
  return Object.freeze({
    ...delivery,
    provider: "github" as const,
    connectionId: connection.id,
    repositoryId: connection.repositoryId,
    webhookId: connection.webhookId,
    [verifiedDeliveryBrand]: true as const,
  });
}

export function createGithubDeliveryService(options: {
  database: SqliteDatabase;
  api: GithubApi;
  secretStore: SecretStore;
}) {
  const access = createGithubInstallationAccessService(options);

  async function getVerifiedConnection(connectionId: unknown): Promise<{
    connection: NonNullable<ReturnType<typeof getApplicationConnection>>;
    context: GithubInstallationContext;
    token: string;
  }> {
    if (typeof connectionId !== "string" || connectionId.length === 0) {
      throw new GithubConnectionError("INVALID_INPUT", "Application connection ID is required.");
    }
    const persistedConnection = getApplicationConnection(
      options.database,
      connectionId,
    );
    if (persistedConnection === null) {
      throw new GithubConnectionError("NOT_FOUND", "Application connection was not found.");
    }
    let connection: NonNullable<ReturnType<typeof getApplicationConnection>> =
      persistedConnection;
    const context = access.getContext(connection.githubInstallationId);
    const credential = await access.createInstallationAccessToken(context, [connection.repositoryId]);
    let repositories: unknown[];
    try {
      repositories = await options.api.listInstallationRepositories(credential.token);
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The connected repository is no longer accessible.");
    }
    const matches = repositories
      .map((item) => parseGithubRepository(item))
      .filter((repository) => repository.id === connection.repositoryId);
    if (matches.length !== 1) {
      throw new GithubConnectionError("REMOTE_INVALID", "The connected repository identity changed.");
    }
    const repository = matches[0];
    let hookResponse: unknown;
    try {
      hookResponse = await options.api.getRepositoryHook(
        repository.fullName,
        connection.webhookId,
        credential.token,
      );
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The connected webhook is no longer accessible.");
    }
    const webhook = parseGithubWebhook(hookResponse);
    if (webhook.id !== connection.webhookId) {
      throw new GithubConnectionError("REMOTE_INVALID", "The connected webhook identity changed.");
    }

    // The sanitized target is display-only. Hook ID plus repository ID and the
    // verified installation are the authority. Refresh canonical presentation
    // if the repository was renamed or the same hook's URL changed; never
    // persist the raw target and never use the display field for API calls.
    if (
      repository.fullName !== connection.repositoryFullName ||
      webhook.targetDisplay !== connection.webhookTargetDisplay
    ) {
      const updatedAt = new Date().toISOString();
      options.database.run(
        `UPDATE application_connections
            SET repository_full_name = ?, webhook_target_display = ?, updated_at = ?
          WHERE id = ? AND repository_id = ? AND webhook_id = ?`,
        [
          repository.fullName,
          webhook.targetDisplay,
          updatedAt,
          connection.id,
          connection.repositoryId,
          connection.webhookId,
        ],
      );
      const refreshed = getApplicationConnection(options.database, connection.id);
      if (refreshed === null) {
        throw new GithubConnectionError("RECOVERY_REQUIRED", "The connected webhook display could not be refreshed.");
      }
      connection = refreshed;
    }
    return { connection, context, token: credential.token };
  }

  function parseFailedDelivery(value: unknown): FailedDeliveryChoice | null {
    const delivery = parseGithubWebhookDelivery(value);
    if (!isFailedGithubWebhookDelivery(delivery)) return null;
    return {
      ...delivery,
      status: delivery.status ?? "FAILED",
    };
  }

  async function listFailedDeliveries(connectionId: unknown): Promise<FailedDeliveryChoice[]> {
    const { connection, token } = await getVerifiedConnection(connectionId);
    let response: unknown;
    try {
      response = await options.api.listWebhookDeliveries(
        connection.repositoryFullName,
        connection.webhookId,
        token,
      );
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "Webhook deliveries could not be discovered.");
    }
    if (!Array.isArray(response)) {
      throw new GithubConnectionError("REMOTE_INVALID", "GitHub webhook deliveries response is invalid.");
    }
    const failed: FailedDeliveryChoice[] = [];
    const seen = new Set<string>();
    for (const item of response) {
      const delivery = parseFailedDelivery(item);
      if (delivery === null || seen.has(delivery.id)) continue;
      seen.add(delivery.id);
      failed.push(delivery);
    }
    return failed;
  }

  async function getFailedDelivery(
    connectionId: unknown,
    deliveryId: unknown,
  ): Promise<VerifiedGithubFailedDelivery> {
    if (
      typeof deliveryId !== "string" ||
      deliveryId.length === 0 ||
      deliveryId.length > 1024
    ) {
      throw new GithubConnectionError("INVALID_INPUT", "Delivery ID is required.");
    }
    const { connection, token } = await getVerifiedConnection(connectionId);
    let response: unknown;
    try {
      response = await options.api.getWebhookDelivery(
        connection.repositoryFullName,
        connection.webhookId,
        deliveryId,
        token,
      );
    } catch {
      throw new GithubConnectionError("NOT_ACCESSIBLE", "The selected webhook delivery is not accessible.");
    }
    const delivery = parseGithubWebhookDelivery(response);
    if (delivery.id !== deliveryId || !isFailedGithubWebhookDelivery(delivery)) {
      throw new GithubConnectionError("REMOTE_INVALID", "The selected delivery is not a verified failure.");
    }
    return makeVerifiedGithubFailedDelivery(
      connection,
      { ...delivery, status: delivery.status ?? "FAILED" },
    );
  }

  async function createIncidentFromVerifiedConnectionDelivery(
    connectionId: unknown,
    deliveryId: unknown,
  ) {
    const verified = await getFailedDelivery(connectionId, deliveryId);
    return createIncidentService(options.database).createFromVerifiedConnectionDelivery(
      verified,
    );
  }

  return {
    listFailedDeliveries,
    getFailedDelivery,
    getVerifiedConnection,
    createIncidentFromVerifiedConnectionDelivery,
  };
}
