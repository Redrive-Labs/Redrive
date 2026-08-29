import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeConfiguredDatabase, getConfiguredDatabase, openDatabase } from "@/server/database";
import { FilesystemSecretStore, manifestPrivateKeyReference, SecretStoreError } from "@/server/secret-store";
import { POST as startManifest } from "./route";
import { GET as manifestCallback } from "./callback/route";

const PEM = "-----BEGIN PRIVATE KEY-----\nsecret-material\n-----END PRIVATE KEY-----\n";

describe("GitHub App manifest routes", () => {
  let directory: string;
  let databasePath: string;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-manifest-route-test-"));
    databasePath = path.join(directory, "records.sqlite");
    process.env.REDRIVE_DATABASE_PATH = databasePath;
    process.env.REDRIVE_SECRET_DIR = path.join(directory, "secrets");
    process.env.REDRIVE_PUBLIC_URL = "https://configured.redrive.example/base";
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

  async function start(targetType: "personal" | "organization", ownerLogin?: string) {
    const response = await startManifest(new Request("http://attacker.invalid/api/integrations/github/app-manifest", {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ targetType, ownerLogin }),
    }));
    expect(response.status).toBe(200);
    return (await response.json()) as {
      attemptId: string;
      expiresAt: string;
      githubRegistrationUrl: string;
      manifest: Record<string, unknown>;
    };
  }

  it("creates personal and organization HTML registration targets from only the configured public URL", async () => {
    const personal = await start("personal");
    expect(personal.githubRegistrationUrl).toMatch(/^https:\/\/github\.com\/settings\/apps\/new\?state=/);
    expect(personal.manifest).toMatchObject({
      url: "https://configured.redrive.example/base",
      hook_attributes: {
        url: "https://configured.redrive.example/base/api/integrations/github/app-webhook-disabled",
        active: false,
      },
      redirect_url: "https://configured.redrive.example/base/api/integrations/github/app-manifest/callback",
      setup_url: "https://configured.redrive.example/base/api/integrations/github/install/callback",
      public: false,
      default_permissions: { contents: "read", repository_hooks: "write" },
      default_events: [],
      request_oauth_on_install: false,
    });
    const organization = await start("organization", "acme");
    expect(organization.githubRegistrationUrl).toMatch(/^https:\/\/github\.com\/organizations\/acme\/settings\/apps\/new\?state=/);
    expect(organization.githubRegistrationUrl).not.toContain("attacker.invalid");

    const htmlResponse = await startManifest(new Request("http://attacker.invalid/api/integrations/github/app-manifest", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "targetType=organization&ownerLogin=acme",
    }));
    const html = await htmlResponse.text();
    expect(htmlResponse.headers.get("content-type")).toContain("text/html");
    expect(html).toContain('method="post"');
    expect(html).toContain('name="manifest"');
    expect(html).toContain("https://github.com/organizations/acme/settings/apps/new?state=");
  });

  it("converts once, stores the PEM outside SQLite, and safely handles a duplicate callback", async () => {
    const started = await start("personal");
    const registrationUrl = new URL(started.githubRegistrationUrl);
    const state = registrationUrl.searchParams.get("state");
    expect(state).toEqual(expect.any(String));
    const fetchImplementation = vi.fn(async () => new Response(
      `{"app_id":900719925474099312345678901234567890,"id":900719925474099312345678901234567890,"slug":"redrive-recovery","owner":{"id":9007199254740993,"login":"octocat","type":"User"},"pem":${JSON.stringify(PEM)},"client_secret":"never-store","webhook_secret":"never-store"}`,
      { status: 201, headers: { "content-type": "application/vnd.github+json" } },
    ));
    vi.stubGlobal("fetch", fetchImplementation);

    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "one-time-code");
    callbackUrl.searchParams.set("state", state as string);
    const first = await manifestCallback(new Request(callbackUrl, { headers: { accept: "application/json" } }));
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { registrationId: string; installationUrl: string; status: string };
    expect(firstBody.status).toBe("APP_CREATED");
    expect(firstBody.installationUrl).toMatch(/^https:\/\/github\.com\/apps\/redrive-recovery\/installations\/new\?state=/);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);

    const database = openDatabase(databasePath);
    try {
      expect(database.get<{ github_app_id: string; owner_id: string; owner_login: string }>("SELECT github_app_id, owner_id, owner_login FROM github_app_registrations")).toEqual({
        github_app_id: "900719925474099312345678901234567890",
        owner_id: "9007199254740993",
        owner_login: "octocat",
      });
      const storedRegistration = JSON.stringify(database.all("SELECT * FROM github_app_registrations"));
      expect(storedRegistration).not.toContain("PRIVATE KEY");
      expect(storedRegistration).not.toContain("client_secret");
      expect(storedRegistration).not.toContain("webhook_secret");
      expect(database.get<{ status: string }>("SELECT status FROM github_manifest_attempts WHERE id = ?", [started.attemptId])?.status).toBe("COMPLETED");
    } finally {
      database.close();
    }
    const secretFiles = readdirSync(path.join(directory, "secrets"));
    expect(secretFiles).toEqual([manifestPrivateKeyReference(started.attemptId)]);
    expect(
      readFileSync(
        path.join(directory, "secrets", manifestPrivateKeyReference(started.attemptId)),
        "utf8",
      ),
    ).toBe(PEM);

    const duplicate = await manifestCallback(new Request(callbackUrl, { headers: { accept: "application/json" } }));
    expect(duplicate.status).toBe(200);
    expect((await duplicate.json() as { status: string }).status).toBe("APP_ALREADY_CREATED");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const afterDuplicate = openDatabase(databasePath);
    try {
      expect(afterDuplicate.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_installation_attempts")?.count).toBe(1);
    } finally {
      afterDuplicate.close();
    }
  });

  it("records remote App identity before a secret-store failure and fails closed", async () => {
    const started = await start("personal");
    const blockedSecretPath = path.join(directory, "blocked-secrets");
    writeFileSync(blockedSecretPath, "not-a-directory");
    process.env.REDRIVE_SECRET_DIR = blockedSecretPath;
    const fetchImplementation = vi.fn(async () => new Response(
      `{"app_id":900719925474099312345678901234567890,"id":900719925474099312345678901234567890,"slug":"redrive-recovery","owner":{"id":9007199254740993,"login":"octocat","type":"User"},"pem":${JSON.stringify(PEM)}}`,
      { status: 201, headers: { "content-type": "application/vnd.github+json" } },
    ));
    vi.stubGlobal("fetch", fetchImplementation);
    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "code");
    callbackUrl.searchParams.set("state", state);
    const first = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(first.status).toBe(503);
    const database = openDatabase(databasePath);
    try {
      expect(database.get<{ status: string; remote_github_app_id: string; remote_slug: string; recovery_reason: string }>(
        "SELECT status, remote_github_app_id, remote_slug, recovery_reason FROM github_manifest_attempts WHERE id = ?",
        [started.attemptId],
      )).toEqual({
        status: "RECOVERY_REQUIRED",
        remote_github_app_id: "900719925474099312345678901234567890",
        remote_slug: "redrive-recovery",
        recovery_reason: "The conversion checkpoint is durable, but its deterministic private-key reference was not confirmed persisted.",
      });
      expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_app_registrations")?.count).toBe(0);
    } finally { database.close(); }
    const second = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(second.status).toBe(503);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(blockedSecretPath, manifestPrivateKeyReference(started.attemptId)))).toBe(false);
  });

  it("rejects wrong state and makes an ambiguous conversion recovery-required without retrying", async () => {
    const started = await start("personal");
    const fetchImplementation = vi.fn(async () => { throw new Error("network outcome unknown"); });
    vi.stubGlobal("fetch", fetchImplementation);
    const wrong = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback?code=code&state=wrong-state");
    expect((await manifestCallback(new Request(wrong, { headers: { accept: "application/json" } }))).status).toBe(400);
    expect(fetchImplementation).not.toHaveBeenCalled();

    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "code");
    callbackUrl.searchParams.set("state", state);
    expect((await manifestCallback(new Request(callbackUrl, { headers: { accept: "application/json" } }))).status).toBe(503);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect((await manifestCallback(new Request(callbackUrl, { headers: { accept: "application/json" } }))).status).toBe(503);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(existsSync(path.join(directory, "secrets"))).toBe(false);
  });

  it("accepts ASCII case differences for organization owners and stores GitHub's canonical login", async () => {
    const started = await start("organization", "Acme");
    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      `{"app_id":900719925474099312345678901234567890,"slug":"redrive-recovery","owner":{"id":9007199254740993,"login":"acme","type":"Organization"},"pem":${JSON.stringify(PEM)}}`,
      { status: 201, headers: { "content-type": "application/vnd.github+json" } },
    )));
    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "code");
    callbackUrl.searchParams.set("state", state);

    const response = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );

    expect(response.status).toBe(200);
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ owner_login: string; status: string }>(
          `SELECT r.owner_login, a.status
             FROM github_app_registrations r
             JOIN github_manifest_attempts a ON a.app_registration_id = r.id
            WHERE a.id = ?`,
          [started.attemptId],
        ),
      ).toEqual({ owner_login: "acme", status: "COMPLETED" });
    } finally {
      database.close();
    }
  });

  it("rejects a genuinely different organization owner", async () => {
    const started = await start("organization", "Acme");
    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    const fetchImplementation = vi.fn(async () => new Response(
      `{"app_id":900719925474099312345678901234567890,"slug":"redrive-recovery","owner":{"id":9007199254740993,"login":"other","type":"Organization"},"pem":${JSON.stringify(PEM)}}`,
      { status: 201, headers: { "content-type": "application/vnd.github+json" } },
    ));
    vi.stubGlobal("fetch", fetchImplementation);
    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "code");
    callbackUrl.searchParams.set("state", state);

    const response = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );

    expect(response.status).toBe(503);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    const database = openDatabase(databasePath);
    try {
      expect(
        database.get<{ status: string }>(
          "SELECT status FROM github_manifest_attempts WHERE id = ?",
          [started.attemptId],
        ),
      ).toEqual({ status: "RECOVERY_REQUIRED" });
    } finally {
      database.close();
    }
  });

  it("retains the deterministic key reference after finalization failure without reconverting", async () => {
    const started = await start("personal");
    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    const fetchImplementation = vi.fn(async () => new Response(
      `{"app_id":900719925474099312345678901234567890,"slug":"redrive-recovery","owner":{"id":9007199254740993,"login":"octocat","type":"User"},"pem":${JSON.stringify(PEM)}}`,
      { status: 201, headers: { "content-type": "application/vnd.github+json" } },
    ));
    vi.stubGlobal("fetch", fetchImplementation);
    const database = getConfiguredDatabase(databasePath);
    const originalRun = database.run.bind(database);
    let injected = false;
    const finalizationFailure = vi.spyOn(database, "run").mockImplementation((sql, parameters) => {
      if (!injected && sql.includes("INSERT INTO github_app_registrations")) {
        injected = true;
        throw new Error("injected manifest finalization failure");
      }
      return originalRun(sql, parameters);
    });
    const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
    callbackUrl.searchParams.set("code", "code");
    callbackUrl.searchParams.set("state", state);

    const first = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );

    expect(first.status).toBe(503);
    const reference = manifestPrivateKeyReference(started.attemptId);
    expect(readFileSync(path.join(directory, "secrets", reference), "utf8")).toBe(PEM);
    const afterFailure = openDatabase(databasePath);
    try {
      expect(afterFailure.get<{ status: string; remote_github_app_id: string; remote_slug: string; recovery_reason: string }>(
        "SELECT status, remote_github_app_id, remote_slug, recovery_reason FROM github_manifest_attempts WHERE id = ?",
        [started.attemptId],
      )).toEqual({
        status: "RECOVERY_REQUIRED",
        remote_github_app_id: "900719925474099312345678901234567890",
        remote_slug: "redrive-recovery",
        recovery_reason: "The conversion checkpoint and deterministic private-key reference were persisted, but final local registration failed.",
      });
      expect(afterFailure.get<{ count: number }>("SELECT COUNT(*) AS count FROM github_app_registrations")?.count).toBe(0);
    } finally {
      afterFailure.close();
    }

    const second = await manifestCallback(
      new Request(callbackUrl, { headers: { accept: "application/json" } }),
    );
    expect(second.status).toBe(200);
    expect((await second.json() as { status: string }).status).toBe("APP_CREATED");
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    finalizationFailure.mockRestore();
  });


  it("tells the operator to retry, not recreate, after transient reconciliation failure", async () => {
    const started = await start("personal");
    const state = new URL(started.githubRegistrationUrl).searchParams.get("state") as string;
    const digest = "a".repeat(64);
    const database = openDatabase(databasePath);
    database.run(
      `UPDATE github_manifest_attempts
          SET status = ?, remote_github_app_id = ?, remote_slug = ?,
              remote_owner_id = ?, remote_owner_login = ?, remote_owner_type = ?,
              private_key_sha256 = ?, recovery_reason = ?
        WHERE id = ?`,
      ["RECOVERY_REQUIRED", "app-1", "redrive-recovery", "owner-1", "octocat", "User", digest, "prior failure", started.attemptId],
    );
    database.close();
    const verification = vi.spyOn(FilesystemSecretStore.prototype, "verifyPrivateKeyForManifestAttempt")
      .mockImplementation(() => {
        throw new SecretStoreError("temporary stat failure", true);
      });
    try {
      const callbackUrl = new URL("https://configured.redrive.example/base/api/integrations/github/app-manifest/callback");
      callbackUrl.searchParams.set("code", "unused");
      callbackUrl.searchParams.set("state", state);
      const response = await manifestCallback(new Request(callbackUrl, { headers: { accept: "application/json" } }));
      expect(response.status).toBe(503);
      const body = await response.json() as { error: string };
      expect(body.error).toContain("retry later");
      expect(body.error).not.toContain("Recreate");
      expect(verification).toHaveBeenCalledTimes(1);
    } finally {
      verification.mockRestore();
    }
  });

});
