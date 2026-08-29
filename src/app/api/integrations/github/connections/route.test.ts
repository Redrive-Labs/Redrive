import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConfiguredDatabase, openDatabase } from "@/server/database";
import { FilesystemSecretStore } from "@/server/secret-store";
import { POST, GET } from "./route";
import { GET as listRepositories } from "../repositories/route";
import { GET as listWebhooks } from "../webhooks/route";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const REPOSITORY_ID = "900719925474099312345678901234567890";
const WEBHOOK_ID = "900719925474099312345678901234567891";
const INSTALLATION_ID = "900719925474099312345678901234567892";

describe("application connection route", () => {
  let directory: string;
  let databasePath: string;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-connections-route-test-"));
    databasePath = path.join(directory, "records.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    process.env.REDRIVE_SECRET_DIR = path.join(directory, "secrets");
    process.env.REDRIVE_PUBLIC_URL = "https://redrive.example";
    const database = openDatabase(databasePath);
    const privateKeyRef = new FilesystemSecretStore(path.join(directory, "secrets")).putPrivateKey(privateKey);
    database.run(`INSERT INTO github_app_registrations (id, github_app_id, slug, owner_id, owner_login, owner_type, private_key_ref, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, ["app-1", "900719925474099312345678901234567893", "redrive", "1", "octocat", "User", privateKeyRef, "2026-01-01", "2026-01-01"]);
    database.run(`INSERT INTO github_installations (installation_id, app_registration_id, account_id, account_login, account_type, repository_selection, last_verified_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [INSTALLATION_ID, "app-1", "2", "octocat", "User", "selected", "2026-01-01", "2026-01-01", "2026-01-01"]);
    database.close();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    closeConfiguredDatabase(databasePath);
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(directory, { recursive: true, force: true });
  });

  it("re-fetches canonical repository and hook data, strips hook credentials, and is idempotent", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return new Response('{"token":"temporary-installation-token","expires_at":"2026-01-01T00:10:00Z"}', { status: 201, headers: { "content-type": "application/vnd.github+json" } });
      }
      if (url.includes("/installation/repositories?")) {
        return new Response(`{"repositories":[{"id":${REPOSITORY_ID},"full_name":"octocat/receiver","private":true,"default_branch":"main"}]}`, { status: 200, headers: { "content-type": "application/vnd.github+json" } });
      }
      if (url.endsWith(`/repos/octocat/receiver/hooks/${WEBHOOK_ID}`)) {
        return new Response(`{"id":${WEBHOOK_ID},"name":"web","active":true,"events":["push"],"config":{"url":"https://receiver.example/webhooks/github?token=secret"}}`, { status: 200, headers: { "content-type": "application/vnd.github+json" } });
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchImplementation);
    const body = {
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      webhookId: WEBHOOK_ID,
      repositoryFullName: "attacker/forged",
      webhookTargetDisplay: "https://attacker.invalid/forged",
    };
    const first = await POST(new Request("http://attacker.invalid/api/integrations/github/connections", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(first.status).toBe(201);
    const firstBody = await first.json() as { connection: Record<string, unknown> };
    expect(firstBody.connection).toMatchObject({ repositoryId: REPOSITORY_ID, repositoryFullName: "octocat/receiver", webhookId: WEBHOOK_ID, webhookTargetDisplay: "https://receiver.example/webhooks/github", state: "READY" });
    const duplicate = await POST(new Request("http://attacker.invalid/api/integrations/github/connections", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    }));
    expect(duplicate.status).toBe(200);
    expect(await duplicate.json()).toEqual(firstBody);
    expect(fetchImplementation).toHaveBeenCalled();
    const authHeaders = fetchImplementation.mock.calls.map(([, init]) => (init?.headers as Record<string, string> | undefined)?.Authorization).filter(Boolean);
    expect(authHeaders.every((value) => value?.startsWith("Bearer "))).toBe(true);

    const listed = await GET();
    expect(await listed.json()).toMatchObject({ connections: [expect.objectContaining({ account: expect.objectContaining({ login: "octocat" }), webhookTargetDisplay: "https://receiver.example/webhooks/github" })] });
    const database = openDatabase(databasePath);
    try {
      expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM application_connections")?.count).toBe(1);
      expect(JSON.stringify(database.all("SELECT * FROM application_connections"))).not.toContain("token=secret");
    } finally { database.close(); }
  });

  it("preserves unsafe repository and webhook IDs through discovery endpoints", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) {
        return new Response('{"token":"temporary-installation-token"}', {
          status: 201,
          headers: { "content-type": "application/vnd.github+json" },
        });
      }
      if (url.includes("/installation/repositories?")) {
        return new Response(
          `{"repositories":[{"id":${REPOSITORY_ID},"full_name":"octocat/receiver","private":true,"default_branch":"main"}]}`,
          { status: 200, headers: { "content-type": "application/vnd.github+json" } },
        );
      }
      if (url.includes("/repos/octocat/receiver/hooks?")) {
        return new Response(
          `[{"id":${WEBHOOK_ID},"name":"web","active":true,"events":["push"],"config":{"url":"https://receiver.example/webhook?token=secret"}}]`,
          { status: 200, headers: { "content-type": "application/vnd.github+json" } },
        );
      }
      throw new Error(`unexpected URL ${url}`);
    });
    vi.stubGlobal("fetch", fetchImplementation);

    const repositoriesUrl = new URL("https://redrive.example/api/integrations/github/repositories");
    repositoriesUrl.searchParams.set("installationId", INSTALLATION_ID);
    const repositoriesResponse = await listRepositories(new Request(repositoriesUrl));
    expect(repositoriesResponse.status).toBe(200);
    await expect(repositoriesResponse.json()).resolves.toEqual({
      repositories: [{
        id: REPOSITORY_ID,
        fullName: "octocat/receiver",
        private: true,
        defaultBranch: "main",
      }],
    });

    const webhooksUrl = new URL("https://redrive.example/api/integrations/github/webhooks");
    webhooksUrl.searchParams.set("installationId", INSTALLATION_ID);
    webhooksUrl.searchParams.set("repositoryId", REPOSITORY_ID);
    const webhooksResponse = await listWebhooks(new Request(webhooksUrl));
    expect(webhooksResponse.status).toBe(200);
    await expect(webhooksResponse.json()).resolves.toEqual({
      repository: {
        id: REPOSITORY_ID,
        fullName: "octocat/receiver",
        private: true,
        defaultBranch: "main",
      },
      webhooks: [{
        id: WEBHOOK_ID,
        name: "web",
        targetDisplay: "https://receiver.example/webhook",
        active: true,
        events: ["push"],
      }],
    });
  });

  it("rejects a repository that the installation cannot access", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/app/installations/${INSTALLATION_ID}/access_tokens`)) return new Response('{"token":"token"}', { status: 201, headers: { "content-type": "application/vnd.github+json" } });
      return new Response('{"repositories":[]}', { status: 200, headers: { "content-type": "application/vnd.github+json" } });
    });
    vi.stubGlobal("fetch", fetchImplementation);
    const response = await POST(new Request("http://redrive.example/api/integrations/github/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, webhookId: WEBHOOK_ID }) }));
    expect(response.status).toBe(502);
  });
});
