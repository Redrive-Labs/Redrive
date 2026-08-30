import {
  createHash,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDeploymentCandidate,
  computeDeploymentFingerprint,
  createRecoveryDeploymentService,
  DeploymentAlreadyAttemptedError,
  DeploymentFingerprintMismatchError,
  DeploymentNotEligibleError,
  DeploymentOutcomeUnknownError,
  DeploymentPreconditionError,
  DeploymentReconciliationRequiredError,
  DeploymentVerificationError,
  getDemoReceiverDeploymentConfiguration,
  serializeDeploymentCandidateForFingerprint,
  type CommandResult,
  type DeploymentCommandRunner,
  type ReceiverBusinessStateReader,
} from "@/server/recovery-deployment-service";
import { openDatabase, type SqliteDatabase } from "@/server/database";

const INCIDENT_ID = "incident-deploy-1";
const APPLICATION_CONNECTION_ID = "application-connection-deploy-1";
const ATTEMPT_ID = "attempt-deploy-1";
const DELIVERY_GUID = "delivery-guid-deploy-1";
const ORIGINAL_REVISION = "5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79";
const REPOSITORY_FULL_NAME = "octocat/receiver";
const PATCH_TEXT = "diff --git a/src/handler.ts b/src/handler.ts\n";
const START = "2026-08-30T00:00:00.000Z";

interface CommandCall {
  executable: string;
  args: string[];
  cwd: string;
}

function patchDigest(patchText = PATCH_TEXT): string {
  return createHash("sha256").update(patchText, "utf8").digest("hex");
}

function insertApplicationConnection(database: SqliteDatabase): void {
  database.run(
    `INSERT INTO github_app_registrations
      (id, github_app_id, slug, owner_id, owner_login, owner_type,
       private_key_ref, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "registration-deploy-1",
      "github-app-deploy-1",
      "redrive-deploy",
      "owner-deploy-1",
      "octocat",
      "User",
      "key-ref-deploy-1",
      START,
      START,
    ],
  );
  database.run(
    `INSERT INTO github_installations
      (installation_id, app_registration_id, account_id, account_login,
       account_type, repository_selection, last_verified_at, created_at,
       updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      "installation-deploy-1",
      "registration-deploy-1",
      "account-deploy-1",
      "octocat",
      "User",
      "selected",
      START,
      START,
      START,
    ],
  );
  database.run(
    `INSERT INTO application_connections
      (id, provider, github_installation_id, repository_id,
       repository_full_name, webhook_id, webhook_target_display, state,
       created_at, updated_at)
     VALUES (?, 'github', ?, ?, ?, ?, ?, 'READY', ?, ?)`,
    [
      APPLICATION_CONNECTION_ID,
      "installation-deploy-1",
      "repository-deploy-1",
      REPOSITORY_FULL_NAME,
      "webhook-deploy-1",
      "https://receiver.example/hooks",
      START,
      START,
    ],
  );
  database.run(
    `INSERT INTO incidents
      (id, provider, external_delivery_id, repository_id,
       application_connection_id, status, created_at, updated_at)
     VALUES (?, 'github', ?, ?, ?, 'OPEN', ?, ?)`,
    [
      INCIDENT_ID,
      "provider-delivery-deploy-1",
      "repository-deploy-1",
      APPLICATION_CONNECTION_ID,
      START,
      START,
    ],
  );
}

function insertAttempt(
  database: SqliteDatabase,
  overrides: Partial<{
    id: string;
    state: string;
    patchText: string;
    patchSha256: string;
    verificationPreCount: number | null;
    verificationHttpStatus: number | null;
    verificationPostCount: number | null;
    sourceRepositoryFullName: string;
    originalRevision: string;
    deliveryGuid: string;
  }> = {},
): void {
  const patchText = overrides.patchText ?? PATCH_TEXT;
  database.run(
    `INSERT INTO recovery_attempts (
      id, incident_id, state, recovery_spec_version,
      source_repository_full_name, original_revision, provider_status_code,
      receiver_pre_count, delivery_guid, patch_text, patch_sha256,
      verification_pre_count, verification_http_status,
      verification_post_count, created_at, updated_at, verified_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.id ?? ATTEMPT_ID,
      INCIDENT_ID,
      overrides.state ?? "REPAIR_VERIFIED",
      "redrive.recovery.v1",
      overrides.sourceRepositoryFullName ?? REPOSITORY_FULL_NAME,
      overrides.originalRevision ?? ORIGINAL_REVISION,
      500,
      1,
      overrides.deliveryGuid ?? DELIVERY_GUID,
      patchText,
      overrides.patchSha256 ?? patchDigest(patchText),
      overrides.verificationPreCount === undefined
        ? 1
        : overrides.verificationPreCount,
      overrides.verificationHttpStatus === undefined
        ? 200
        : overrides.verificationHttpStatus,
      overrides.verificationPostCount === undefined
        ? 1
        : overrides.verificationPostCount,
      START,
      START,
      START,
    ],
  );
}

function createRunner(
  repositoryPath: string,
  options: {
    head?: string;
    status?: string;
    onRun?: (call: CommandCall, database: SqliteDatabase) => void;
    result?: (call: CommandCall) => CommandResult;
    error?: (call: CommandCall) => Error | null;
  } = {},
): { runner: DeploymentCommandRunner; calls: CommandCall[] } {
  const calls: CommandCall[] = [];
  return {
    calls,
    runner: {
      run: vi.fn(async (executable, args, runOptions) => {
        const call = { executable, args: [...args], cwd: runOptions.cwd };
        calls.push(call);
        options.onRun?.(call, databaseForRunner);
        const error = options.error?.(call);
        if (error !== null && error !== undefined) throw error;
        if (options.result !== undefined) return options.result(call);
        if (call.args.join(" ") === "-C " + repositoryPath + " rev-parse --show-toplevel") {
          return { exitCode: 0, stdout: `${repositoryPath}\n`, stderr: "" };
        }
        if (call.args.join(" ") === "-C " + repositoryPath + " rev-parse HEAD") {
          return { exitCode: 0, stdout: `${options.head ?? ORIGINAL_REVISION}\n`, stderr: "" };
        }
        if (call.args.join(" ") === "-C " + repositoryPath + " status --porcelain") {
          return { exitCode: 0, stdout: options.status ?? "", stderr: "" };
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    },
  };
}

let databaseForRunner: SqliteDatabase;

function createReader(
  states: Array<Pick<Awaited<ReturnType<ReceiverBusinessStateReader["readBusinessState"]>>, "mutationCount" | "businessState">>,
): ReceiverBusinessStateReader {
  return {
    readBusinessState: vi.fn(async () => states.shift() ?? states[states.length - 1]),
  };
}

describe("recovery deployment slice", () => {
  let testDirectory: string;
  let targetDirectory: string;
  let database: SqliteDatabase;
  let environment: NodeJS.ProcessEnv;

  beforeEach(() => {
    testDirectory = mkdtempSync(path.join(os.tmpdir(), "redrive-deploy-test-"));
    targetDirectory = path.join(testDirectory, "receiver");
    mkdirForTest(targetDirectory);
    writeFileSync(path.join(targetDirectory, "compose.yaml"), "services: {}\n");
    database = openDatabase(path.join(testDirectory, "redrive.sqlite"));
    databaseForRunner = database;
    insertApplicationConnection(database);
    environment = {
      REDRIVE_DEMO_RECEIVER_REPO_PATH: targetDirectory,
    } as unknown as NodeJS.ProcessEnv;
  });

  afterEach(() => {
    database.close();
    rmSync(testDirectory, { recursive: true, force: false });
  });

  function service(
    runner: DeploymentCommandRunner,
    reader: ReceiverBusinessStateReader,
    healthCheck: (url: string) => Promise<number> = async () => 200,
  ) {
    return createRecoveryDeploymentService({
      database,
      environment,
      commandRunner: runner,
      receiverStateReader: reader,
      temporaryDirectory: testDirectory,
      healthCheck,
      healthPollCount: 1,
      sleep: async () => undefined,
      now: () => START,
    });
  }

  function eligibleService() {
    insertAttempt(database);
    const fake = createRunner(targetDirectory);
    const reader = createReader([
      { mutationCount: 1, businessState: "EXACTLY_ONE" },
      { mutationCount: 1, businessState: "EXACTLY_ONE" },
    ]);
    return {
      fake,
      reader,
      service: service(fake.runner, reader),
    };
  }

  it("requires a REPAIR_VERIFIED prerequisite and valid verification invariant", () => {
    const fake = createRunner(targetDirectory);
    const reader = createReader([{ mutationCount: 1, businessState: "EXACTLY_ONE" }]);
    const deployment = service(fake.runner, reader);

    expect(deployment.getStatus(INCIDENT_ID)).toMatchObject({
      eligible: false,
      candidate: null,
    });
    expect(() => deployment.approvePermit(INCIDENT_ID, "0".repeat(64))).toThrow(
      DeploymentNotEligibleError,
    );

    insertAttempt(database, { verificationPreCount: 0 });
    expect(deployment.getStatus(INCIDENT_ID).eligible).toBe(false);
    expect(() => deployment.approvePermit(INCIDENT_ID, "0".repeat(64))).toThrow(
      DeploymentNotEligibleError,
    );
  });

  it("serializes a deterministic candidate and changes fingerprint with patch digest", () => {
    const first = buildDeploymentCandidate({
      incidentId: INCIDENT_ID,
      recoveryAttemptId: ATTEMPT_ID,
      sourceRepositoryFullName: REPOSITORY_FULL_NAME,
      originalRevision: ORIGINAL_REVISION,
      patchSha256: "a".repeat(64),
    });
    const second = { ...first, patchSha256: "b".repeat(64) };
    expect(serializeDeploymentCandidateForFingerprint(first)).toBe(
      JSON.stringify({
        schemaVersion: 1,
        kind: "DEPLOY",
        incidentId: INCIDENT_ID,
        recoveryAttemptId: ATTEMPT_ID,
        sourceRepositoryFullName: REPOSITORY_FULL_NAME,
        originalRevision: ORIGINAL_REVISION,
        patchSha256: "a".repeat(64),
        deploymentTarget: "demo-receiver-local",
      }),
    );
    expect(computeDeploymentFingerprint(first)).not.toBe(
      computeDeploymentFingerprint(second),
    );
  });

  it("requires an absolute, normalized, whitespace-safe demo receiver path", () => {
    expect(
      getDemoReceiverDeploymentConfiguration({
        REDRIVE_DEMO_RECEIVER_REPO_PATH: `${testDirectory}/receiver/../receiver`,
      } as unknown as NodeJS.ProcessEnv),
    ).toEqual({
      repositoryPath: targetDirectory,
      deploymentTarget: "demo-receiver-local",
    });
    for (const configuredPath of ["receiver", `${targetDirectory} `, ""]) {
      expect(() =>
        getDemoReceiverDeploymentConfiguration({
          REDRIVE_DEMO_RECEIVER_REPO_PATH: configuredPath,
        } as unknown as NodeJS.ProcessEnv),
      ).toThrow();
    }
  });

  it("rejects a wrong fingerprint and makes exact permit replay idempotent", () => {
    const { service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const fingerprint = computeDeploymentFingerprint(candidate);

    expect(() => deployment.approvePermit(INCIDENT_ID, "f".repeat(64))).toThrow(
      DeploymentFingerprintMismatchError,
    );
    const first = deployment.approvePermit(INCIDENT_ID, fingerprint);
    const replay = deployment.approvePermit(INCIDENT_ID, fingerprint);
    expect(replay).toEqual(first);
    expect(database.get("SELECT COUNT(*) AS count FROM deploy_permits")).toEqual({ count: 1 });
  });

  it("cannot use a permit for a different current recovery attempt", async () => {
    const { service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(
      INCIDENT_ID,
      computeDeploymentFingerprint(candidate),
    );
    const replacementPatch = "new patch\n";
    database.run(
      `UPDATE recovery_attempts
       SET id = ?, patch_text = ?, patch_sha256 = ?, updated_at = ?
       WHERE id = ?`,
      ["attempt-deploy-2", replacementPatch, patchDigest(replacementPatch), START, ATTEMPT_ID],
    );

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentFingerprintMismatchError,
    );
    expect(database.get("SELECT state FROM deploy_permits WHERE id = ?", [permit.id])).toEqual({
      state: "APPROVED",
    });
  });

  it("recomputes patch identity before authorizing a deployment", () => {
    insertAttempt(database, { patchSha256: "c".repeat(64) });
    const fake = createRunner(targetDirectory);
    const deployment = service(fake.runner, createReader([]));
    expect(deployment.getStatus(INCIDENT_ID).eligible).toBe(false);
    expect(() => deployment.approvePermit(INCIDENT_ID, "c".repeat(64))).toThrow(
      DeploymentNotEligibleError,
    );
  });

  it("blocks dirty targets and wrong HEAD before consuming the permit", async () => {
    for (const runnerOptions of [{ status: " M src/handler.ts" }, { head: "wrong-head" }]) {
      database.run("DELETE FROM recovery_attempts");
      database.run("DELETE FROM deploy_permits");
      database.run("DELETE FROM recovery_deployments");
      insertAttempt(database);
      const fake = createRunner(targetDirectory, runnerOptions);
      const deployment = service(
        fake.runner,
        createReader([{ mutationCount: 1, businessState: "EXACTLY_ONE" }]),
      );
      const candidate = deployment.getStatus(INCIDENT_ID).candidate;
      if (candidate === null) throw new Error("test candidate was not eligible");
      const permit = deployment.approvePermit(
        INCIDENT_ID,
        computeDeploymentFingerprint(candidate),
      );

      await expectDeployRejection(
        deployment.deploy(INCIDENT_ID, permit.id),
        DeploymentPreconditionError,
      );
      expect(database.get("SELECT state FROM deploy_permits WHERE id = ?", [permit.id])).toEqual({
        state: "APPROVED",
      });
      expect(fake.calls.some((call) => call.args.includes("apply"))).toBe(false);
    }
  });

  it("runs the exact preflight/apply/compose command order and persists APPLYING before apply", async () => {
    const { fake, reader, service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(
      INCIDENT_ID,
      computeDeploymentFingerprint(candidate),
    );
    let stateAtApply: string | undefined;
    let checkedPatchText: string | undefined;
    let checkedPatchMode: number | undefined;
    fake.runner.run = vi.fn(async (executable, args, options) => {
      const call = { executable, args: [...args], cwd: options.cwd };
      fake.calls.push(call);
      if (executable === "git" && args.includes("--check")) {
        const patchFile = args[args.length - 1];
        checkedPatchText = readFileSync(patchFile, "utf8");
        checkedPatchMode = statSync(patchFile).mode & 0o777;
      }
      if (executable === "git" && args[args.length - 2] === "apply" && args[args.length - 1] !== "--check") {
        stateAtApply = database.get<{ state: string }>(
          "SELECT state FROM recovery_deployments WHERE deploy_permit_id = ?",
          [permit.id],
        )?.state;
      }
      if (args.join(" ") === `-C ${targetDirectory} rev-parse --show-toplevel`) {
        return { exitCode: 0, stdout: `${targetDirectory}\n`, stderr: "" };
      }
      if (args.join(" ") === `-C ${targetDirectory} rev-parse HEAD`) {
        return { exitCode: 0, stdout: `${ORIGINAL_REVISION}\n`, stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    const result = await deployment.deploy(INCIDENT_ID, permit.id);
    expect(result).toMatchObject({ state: "VERIFIED", preDeployMutationCount: 1, postDeployMutationCount: 1 });
    expect(stateAtApply).toBe("APPLYING");
    expect(fake.calls.map((call) => [call.executable, call.args])).toEqual([
      ["git", ["-C", targetDirectory, "rev-parse", "--show-toplevel"]],
      ["git", ["-C", targetDirectory, "rev-parse", "HEAD"]],
      ["git", ["-C", targetDirectory, "status", "--porcelain"]],
      ["git", ["-C", targetDirectory, "apply", "--check", expect.any(String)]],
      ["git", ["-C", targetDirectory, "rev-parse", "HEAD"]],
      ["git", ["-C", targetDirectory, "status", "--porcelain"]],
      ["git", ["-C", targetDirectory, "apply", expect.any(String)]],
      ["docker", ["compose", "-f", path.join(targetDirectory, "compose.yaml"), "up", "--build", "-d"]],
    ]);
    expect(checkedPatchText).toBe(PATCH_TEXT);
    expect(checkedPatchMode).toBe(0o600);
    expect(() => statSync(fake.calls[3].args[4])).toThrow();
    expect((reader.readBusinessState as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it.each([
    ["HEAD", "checkout mutation", { head: "changed-head" }],
    ["status", "worktree mutation", { status: " M src/handler.ts" }],
  ])("does not apply when the %s changes after preflight", async (_kind, _description, mutation) => {
    const { fake, reader, service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(INCIDENT_ID, computeDeploymentFingerprint(candidate));
    let preflightComplete = false;
    let headReads = 0;
    let statusReads = 0;
    fake.runner.run = vi.fn(async (executable, args, options) => {
      const call = { executable, args: [...args], cwd: options.cwd };
      fake.calls.push(call);
      if (executable === "git" && args.includes("--check")) preflightComplete = true;
      if (executable === "git" && args.includes("HEAD")) headReads += 1;
      if (executable === "git" && args.includes("--porcelain")) statusReads += 1;
      if (args.join(" ") === `-C ${targetDirectory} rev-parse --show-toplevel`) {
        return { exitCode: 0, stdout: `${targetDirectory}\n`, stderr: "" };
      }
      if (args.join(" ") === `-C ${targetDirectory} rev-parse HEAD`) {
        return {
          exitCode: 0,
          stdout: `${preflightComplete && "head" in mutation ? mutation.head : ORIGINAL_REVISION}\n`,
          stderr: "",
        };
      }
      if (args.join(" ") === `-C ${targetDirectory} status --porcelain`) {
        return {
          exitCode: 0,
          stdout: preflightComplete && "status" in mutation ? mutation.status : "",
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentReconciliationRequiredError,
    );
    expect(fake.calls.filter((call) => call.executable === "git" && call.args.includes("apply") && !call.args.includes("--check"))).toHaveLength(0);
    expect(database.get("SELECT state FROM recovery_deployments")).toMatchObject({ state: "APPLYING" });
    expect(headReads).toBe(2);
    expect(statusReads).toBe("status" in mutation ? 2 : 1);
    expect(reader.readBusinessState).toHaveBeenCalledTimes(1);
  });

  it("marks an ambiguous crash after APPLYING unknown and never automatically applies again", async () => {
    const { fake, reader, service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(INCIDENT_ID, computeDeploymentFingerprint(candidate));
    fake.runner.run = vi.fn(async (executable, args, options) => {
      const call = { executable, args: [...args], cwd: options.cwd };
      fake.calls.push(call);
      if (executable === "git" && args.includes("rev-parse") && args.includes("--show-toplevel")) {
        return { exitCode: 0, stdout: `${targetDirectory}\n`, stderr: "" };
      }
      if (executable === "git" && args.includes("HEAD")) {
        return { exitCode: 0, stdout: `${ORIGINAL_REVISION}\n`, stderr: "" };
      }
      if (executable === "git" && args.includes("apply") && !args.includes("--check")) {
        throw new Error("worker process disappeared after starting git apply");
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentOutcomeUnknownError,
    );
    expect(database.get("SELECT state FROM recovery_deployments")).toMatchObject({ state: "OUTCOME_UNKNOWN" });
    const applyCalls = () => fake.calls.filter((call) => call.executable === "git" && call.args.includes("apply") && !call.args.includes("--check"));
    expect(applyCalls()).toHaveLength(1);

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentReconciliationRequiredError,
    );
    expect(applyCalls()).toHaveLength(1);
    expect(reader.readBusinessState).toHaveBeenCalledTimes(1);
  });

  it("blocks a non-200 health result", async () => {
    const { fake, reader, service: base } = eligibleService();
    const candidate = base.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = base.approvePermit(INCIDENT_ID, computeDeploymentFingerprint(candidate));
    const deployment = service(fake.runner, reader, async () => 503);

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentVerificationError,
    );
    expect(database.get("SELECT state, health_status_code FROM recovery_deployments")).toEqual({
      state: "FAILED",
      health_status_code: 503,
    });
    expect(reader.readBusinessState).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ mutationCount: 0, businessState: "ABSENT" as const }],
    [{ mutationCount: 1, businessState: "ABSENT" as const }],
    [{ mutationCount: 2, businessState: "MULTIPLE" as const }],
  ])("blocks post-deploy receiver state %j", async (postState) => {
    insertAttempt(database);
    const fake = createRunner(targetDirectory);
    const reader = createReader([
      { mutationCount: 1, businessState: "EXACTLY_ONE" },
      postState,
    ]);
    const deployment = service(fake.runner, reader);
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(INCIDENT_ID, computeDeploymentFingerprint(candidate));

    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentVerificationError,
    );
    expect(database.get("SELECT state, post_deploy_mutation_count FROM recovery_deployments")).toEqual({
      state: "FAILED",
      post_deploy_mutation_count: postState.mutationCount,
    });
  });

  it("finishes the happy path as VERIFIED with pre and post counts of one", async () => {
    const { fake, service: deployment } = eligibleService();
    const candidate = deployment.getStatus(INCIDENT_ID).candidate;
    if (candidate === null) throw new Error("test candidate was not eligible");
    const permit = deployment.approvePermit(INCIDENT_ID, computeDeploymentFingerprint(candidate));

    const result = await deployment.deploy(INCIDENT_ID, permit.id);
    expect(result).toMatchObject({
      state: "VERIFIED",
      preDeployMutationCount: 1,
      postDeployMutationCount: 1,
      healthStatusCode: 200,
    });
    expect(database.get("SELECT state FROM deploy_permits WHERE id = ?", [permit.id])).toEqual({ state: "CONSUMED" });
    await expectDeployRejection(
      deployment.deploy(INCIDENT_ID, permit.id),
      DeploymentAlreadyAttemptedError,
    );
    expect(fake.calls.filter((call) => call.args.includes("apply") && !call.args.includes("--check"))).toHaveLength(1);
  });
});

function mkdirForTest(directory: string): void {
  mkdirSync(directory, { recursive: true });
}

async function expectDeployRejection(
  promise: Promise<unknown>,
  expected: new (...args: never[]) => Error,
): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(expected);
}
