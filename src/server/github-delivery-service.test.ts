import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "@/server/database";
import { createGithubDeliveryService } from "@/server/github-delivery-service";
import type { GithubApi } from "@/server/github-rest";
import type { SecretStore } from "@/server/secret-store";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const REPOSITORY_ID = "900719925474099312345678901234567890";
const WEBHOOK_ID = "900719925474099312345678901234567891";
const INSTALLATION_ID = "900719925474099312345678901234567892";

class MemorySecretStore implements SecretStore {
  readPrivateKey(): string { return privateKey; }
  putPrivateKey(): string { return "unused"; }
  putPrivateKeyForManifestAttempt(): string { return "unused"; }
}

describe("connection-based GitHub delivery discovery", () => {
  const resources: Array<{ directory: string; database: SqliteDatabase }> = [];
  afterEach(() => {
    for (const resource of resources.splice(0)) {
      resource.database.close();
      rmSync(resource.directory, { recursive: true, force: true });
    }
  });

  function fixture() {
    const directory = mkdtempSync(path.join(os.tmpdir(), "redrive-delivery-test-"));
    const database = openDatabase(path.join(directory, "records.sqlite"));
    database.run(`INSERT INTO github_app_registrations (id, github_app_id, slug, owner_id, owner_login, owner_type, private_key_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["app-1", "9007199254740993123", "redrive", "1", "octocat", "User", "key", "2026-01-01", "2026-01-01"]);
    database.run(`INSERT INTO github_installations (installation_id, app_registration_id, account_id, account_login, account_type, repository_selection, last_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [INSTALLATION_ID, "app-1", "2", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"]);
    database.run(`INSERT INTO application_connections (id, provider, github_installation_id, repository_id, repository_full_name, webhook_id, webhook_target_display, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["connection-1", "github", INSTALLATION_ID, REPOSITORY_ID, "octocat/receiver", WEBHOOK_ID, "https://receiver.example/webhooks/github", "READY", "2026-01-01", "2026-01-01"]);
    const resource = { directory, database };
    resources.push(resource);
    return resource;
  }

  it("lists only failed deliveries and preserves a large delivery ID", async () => {
    const { database } = fixture();
    const api = {
      createInstallationToken: vi.fn(async () => ({ token: "temporary-token" })),
      listInstallationRepositories: vi.fn(async () => [{ id: REPOSITORY_ID, full_name: "octocat/receiver", private: true, default_branch: "main" }]),
      getRepositoryHook: vi.fn(async () => ({ id: WEBHOOK_ID, name: "web", active: true, events: [], config: { url: "https://receiver.example/webhooks/github?token=secret" } })),
      listWebhookDeliveries: vi.fn(async () => [
        { id: "900719925474099312345678901234567899", guid: "failed-guid", status: "Failed", status_code: 500, delivered_at: "2026-01-01T00:00:00Z", event: "push", redelivery: false },
        { id: "success-1", guid: "success-guid", status: "OK", status_code: 200, delivered_at: "2026-01-01T00:00:00Z", event: "push", redelivery: false },
      ]),
      getWebhookDelivery: vi.fn(async () => ({ id: "900719925474099312345678901234567899", status: "Failed", status_code: 500, guid: "failed-guid", delivered_at: "2026-01-01T00:00:00Z", event: "push", redelivery: false })),
    } as unknown as GithubApi;
    const service = createGithubDeliveryService({ database, api, secretStore: new MemorySecretStore() });
    await expect(service.listFailedDeliveries("connection-1")).resolves.toEqual([
      expect.objectContaining({ id: "900719925474099312345678901234567899", status: "Failed", statusCode: 500 }),
    ]);
    await expect(service.getFailedDelivery("connection-1", "900719925474099312345678901234567899")).resolves.toMatchObject({ id: "900719925474099312345678901234567899" });
    expect(JSON.stringify(database.all("SELECT * FROM application_connections"))).not.toContain("temporary-token");
  });

  it("uses installation, repository ID, and hook ID as authority while refreshing display data", async () => {
    const { database } = fixture();
    const api = {
      createInstallationToken: vi.fn(async () => ({ token: "installation-token" })),
      listInstallationRepositories: vi.fn(async () => [
        {
          id: REPOSITORY_ID,
          full_name: "octocat/renamed-receiver",
          private: true,
          default_branch: "main",
        },
      ]),
      getRepositoryHook: vi.fn(async () => ({
        id: WEBHOOK_ID,
        name: "web",
        active: true,
        events: ["push"],
        config: {
          url: "https://user:password@receiver.example/changed?token=secret",
        },
      })),
      listWebhookDeliveries: vi.fn(async () => []),
      getWebhookDelivery: vi.fn(async () => ({})),
    } as unknown as GithubApi;
    const service = createGithubDeliveryService({
      database,
      api,
      secretStore: new MemorySecretStore(),
    });

    const verified = await service.getVerifiedConnection("connection-1");

    expect(verified.connection).toMatchObject({
      repositoryId: REPOSITORY_ID,
      repositoryFullName: "octocat/renamed-receiver",
      webhookId: WEBHOOK_ID,
      webhookTargetDisplay: "https://receiver.example/changed",
    });
    expect(api.getRepositoryHook).toHaveBeenCalledWith(
      "octocat/renamed-receiver",
      WEBHOOK_ID,
      "installation-token",
    );
    expect(
      JSON.stringify(database.all("SELECT * FROM application_connections")),
    ).not.toContain("password");
    expect(
      JSON.stringify(database.all("SELECT * FROM application_connections")),
    ).not.toContain("token=secret");
    expect(
      database.get<{ repository_full_name: string; webhook_target_display: string }>(
        "SELECT repository_full_name, webhook_target_display FROM application_connections WHERE id = ?",
        ["connection-1"],
      ),
    ).toEqual({
      repository_full_name: "octocat/renamed-receiver",
      webhook_target_display: "https://receiver.example/changed",
    });
  });

  it("rejects a changed hook ID or repository association", async () => {
    const hookFixture = fixture();
    const changedHookApi = {
      createInstallationToken: vi.fn(async () => ({ token: "token" })),
      listInstallationRepositories: vi.fn(async () => [
        { id: REPOSITORY_ID, full_name: "octocat/receiver", private: true },
      ]),
      getRepositoryHook: vi.fn(async () => ({
        id: "different-hook",
        name: "web",
        active: true,
        events: [],
        config: { url: "https://receiver.example/webhook" },
      })),
    } as unknown as GithubApi;
    const changedHookService = createGithubDeliveryService({
      database: hookFixture.database,
      api: changedHookApi,
      secretStore: new MemorySecretStore(),
    });
    await expect(
      changedHookService.getVerifiedConnection("connection-1"),
    ).rejects.toMatchObject({
      name: "GithubConnectionError",
      code: "REMOTE_INVALID",
    });

    const repositoryFixture = fixture();
    const changedRepositoryApi = {
      createInstallationToken: vi.fn(async () => ({ token: "token" })),
      listInstallationRepositories: vi.fn(async () => [
        { id: "different-repository", full_name: "octocat/other", private: true },
      ]),
      getRepositoryHook: vi.fn(),
    } as unknown as GithubApi;
    const changedRepositoryService = createGithubDeliveryService({
      database: repositoryFixture.database,
      api: changedRepositoryApi,
      secretStore: new MemorySecretStore(),
    });
    await expect(
      changedRepositoryService.getVerifiedConnection("connection-1"),
    ).rejects.toMatchObject({
      name: "GithubConnectionError",
      code: "REMOTE_INVALID",
    });
    expect(changedRepositoryApi.getRepositoryHook).not.toHaveBeenCalled();
  });

});
