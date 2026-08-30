import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseBusinessStateReadResult,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";
import { getApplicationConnection } from "@/server/github-connection-service";
import { getServerConfig } from "@/server/config";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { createReceiverConnectionService } from "@/server/receiver-connection-service";
import { createReceiverMcpServer } from "@/server/receiver-mcp-server";
import { createReceiverReadJobTransportService } from "@/server/receiver-read-job-service";
import { createIncidentService } from "@/server/incident-service";

export const DEPLOYMENT_TARGET = "demo-receiver-local" as const;
export const DEPLOYMENT_HEALTH_URL = "http://127.0.0.1:3000/health" as const;
export const DEPLOYMENT_SCHEMA_VERSION = 1 as const;
export const DEPLOYMENT_KIND = "DEPLOY" as const;

export type DeployPermitState = "APPROVED" | "CONSUMED" | "REVOKED";
export type RecoveryDeploymentState =
  | "PREPARED"
  | "APPLYING"
  | "VERIFYING"
  | "VERIFIED"
  | "FAILED"
  | "OUTCOME_UNKNOWN";

export interface DeploymentCandidate {
  schemaVersion: typeof DEPLOYMENT_SCHEMA_VERSION;
  kind: typeof DEPLOYMENT_KIND;
  incidentId: string;
  recoveryAttemptId: string;
  sourceRepositoryFullName: string;
  originalRevision: string;
  patchSha256: string;
  deploymentTarget: typeof DEPLOYMENT_TARGET;
}

export interface DeploymentPermit {
  id: string;
  incidentId: string;
  recoveryAttemptId: string;
  fingerprintSha256: string;
  patchSha256: string;
  deploymentTarget: typeof DEPLOYMENT_TARGET;
  state: DeployPermitState;
  approvedAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface RecoveryDeployment {
  id: string;
  incidentId: string;
  recoveryAttemptId: string;
  deployPermitId: string;
  patchSha256: string;
  deploymentTarget: typeof DEPLOYMENT_TARGET;
  state: RecoveryDeploymentState;
  preDeployMutationCount: number | null;
  postDeployMutationCount: number | null;
  healthStatusCode: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DeploymentStatus {
  incidentId: string;
  eligible: boolean;
  reason: string | null;
  candidate: DeploymentCandidate | null;
  fingerprint: string | null;
  permit: DeploymentPermit | null;
  deployment: RecoveryDeployment | null;
}

export interface ReceiverBusinessStateReader {
  readBusinessState(input: {
    applicationConnectionId: string;
    deliveryGuid: string;
  }): Promise<Pick<BusinessStateReadResult, "mutationCount" | "businessState">>;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunOptions {
  cwd: string;
}

export interface DeploymentCommandRunner {
  run(
    executable: string,
    args: readonly string[],
    options: CommandRunOptions,
  ): Promise<CommandResult>;
}

export interface DeploymentServiceOptions {
  database: SqliteDatabase;
  environment?: NodeJS.ProcessEnv;
  commandRunner?: DeploymentCommandRunner;
  receiverStateReader?: ReceiverBusinessStateReader;
  temporaryDirectory?: string;
  healthCheck?: (url: string) => Promise<number>;
  healthPollCount?: number;
  healthPollIntervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => string;
}

export class DeploymentNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotFoundError";
  }
}

export class DeploymentNotEligibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentNotEligibleError";
  }
}

export class DeploymentConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentConfigurationError";
  }
}

export class DeploymentFingerprintMismatchError extends Error {
  constructor() {
    super("The submitted deployment fingerprint does not match the current candidate.");
    this.name = "DeploymentFingerprintMismatchError";
  }
}

export class DeploymentPermitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentPermitError";
  }
}

export class DeploymentPreconditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentPreconditionError";
  }
}

export class DeploymentAlreadyAttemptedError extends Error {
  readonly deployment: RecoveryDeployment;

  constructor(deployment: RecoveryDeployment) {
    super("This deployment permit has already been consumed.");
    this.name = "DeploymentAlreadyAttemptedError";
    this.deployment = deployment;
  }
}

export class DeploymentReconciliationRequiredError extends Error {
  readonly deployment: RecoveryDeployment;

  constructor(deployment: RecoveryDeployment) {
    super(
      "Deployment execution is blocked pending manual reconciliation of its durable outcome.",
    );
    this.name = "DeploymentReconciliationRequiredError";
    this.deployment = deployment;
  }
}

export class DeploymentCommandFailure extends Error {
  readonly outcome: "DEFINITE_FAILURE" | "AMBIGUOUS";
  readonly exitCode: number | null;

  constructor(
    message: string,
    outcome: "DEFINITE_FAILURE" | "AMBIGUOUS",
    exitCode: number | null = null,
  ) {
    super(message);
    this.name = "DeploymentCommandFailure";
    this.outcome = outcome;
    this.exitCode = exitCode;
  }
}

export class DeploymentExecutionError extends Error {
  readonly deployment: RecoveryDeployment;

  constructor(deployment: RecoveryDeployment, message: string) {
    super(message);
    this.name = "DeploymentExecutionError";
    this.deployment = deployment;
  }
}

export class DeploymentOutcomeUnknownError extends Error {
  readonly deployment: RecoveryDeployment;

  constructor(deployment: RecoveryDeployment, message = "Deployment outcome is unknown.") {
    super(message);
    this.name = "DeploymentOutcomeUnknownError";
    this.deployment = deployment;
  }
}

export class DeploymentVerificationError extends Error {
  readonly deployment: RecoveryDeployment;

  constructor(deployment: RecoveryDeployment, message: string) {
    super(message);
    this.name = "DeploymentVerificationError";
    this.deployment = deployment;
  }
}

interface RecoveryAttemptArtifact {
  id: string;
  incidentId: string;
  state: string;
  sourceRepositoryFullName: string;
  originalRevision: string;
  deliveryGuid: string;
  patchText: string;
  patchSha256: string;
  verificationPreCount: number;
  verificationHttpStatus: number;
  verificationPostCount: number;
}

interface CandidateRead {
  artifact: RecoveryAttemptArtifact | null;
  candidate: DeploymentCandidate | null;
  reason: string | null;
}

interface RecoveryAttemptRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  state: unknown;
  sourceRepositoryFullName: unknown;
  originalRevision: unknown;
  deliveryGuid: unknown;
  patchText: unknown;
  patchSha256: unknown;
  verificationPreCount: unknown;
  verificationHttpStatus: unknown;
  verificationPostCount: unknown;
}

interface PermitRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  recoveryAttemptId: unknown;
  fingerprintSha256: unknown;
  patchSha256: unknown;
  deploymentTarget: unknown;
  state: unknown;
  approvedAt: unknown;
  consumedAt: unknown;
  createdAt: unknown;
}

interface DeploymentRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  recoveryAttemptId: unknown;
  deployPermitId: unknown;
  patchSha256: unknown;
  deploymentTarget: unknown;
  state: unknown;
  preDeployMutationCount: unknown;
  postDeployMutationCount: unknown;
  healthStatusCode: unknown;
  startedAt: unknown;
  completedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const recoveryAttemptColumns = `
  id,
  incident_id AS incidentId,
  state,
  source_repository_full_name AS sourceRepositoryFullName,
  original_revision AS originalRevision,
  delivery_guid AS deliveryGuid,
  patch_text AS patchText,
  patch_sha256 AS patchSha256,
  verification_pre_count AS verificationPreCount,
  verification_http_status AS verificationHttpStatus,
  verification_post_count AS verificationPostCount
`;

const permitColumns = `
  id,
  incident_id AS incidentId,
  recovery_attempt_id AS recoveryAttemptId,
  fingerprint_sha256 AS fingerprintSha256,
  patch_sha256 AS patchSha256,
  deployment_target AS deploymentTarget,
  state,
  approved_at AS approvedAt,
  consumed_at AS consumedAt,
  created_at AS createdAt
`;

const deploymentColumns = `
  id,
  incident_id AS incidentId,
  recovery_attempt_id AS recoveryAttemptId,
  deploy_permit_id AS deployPermitId,
  patch_sha256 AS patchSha256,
  deployment_target AS deploymentTarget,
  state,
  pre_deploy_mutation_count AS preDeployMutationCount,
  post_deploy_mutation_count AS postDeployMutationCount,
  health_status_code AS healthStatusCode,
  started_at AS startedAt,
  completed_at AS completedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function readNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`The ${field} value is invalid.`);
  }
  return value;
}

function readNullableText(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return readNonEmptyText(value, field);
}

function readNonNegativeInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0
  ) {
    throw new Error(`The ${field} value is invalid.`);
  }
  return value;
}

function readNullableNonNegativeInteger(
  value: unknown,
  field: string,
): number | null {
  if (value === null || value === undefined) return null;
  return readNonNegativeInteger(value, field);
}

function readPermitState(value: unknown): DeployPermitState {
  if (value !== "APPROVED" && value !== "CONSUMED" && value !== "REVOKED") {
    throw new Error("The deployment permit state is invalid.");
  }
  return value;
}

function readDeploymentState(value: unknown): RecoveryDeploymentState {
  if (
    value !== "PREPARED" &&
    value !== "APPLYING" &&
    value !== "VERIFYING" &&
    value !== "VERIFIED" &&
    value !== "FAILED" &&
    value !== "OUTCOME_UNKNOWN"
  ) {
    throw new Error("The recovery deployment state is invalid.");
  }
  return value;
}

function mapPermit(row: PermitRow): DeploymentPermit {
  const deploymentTarget = readNonEmptyText(row.deploymentTarget, "deployment target");
  if (deploymentTarget !== DEPLOYMENT_TARGET) {
    throw new Error("The deployment permit target is invalid.");
  }
  const fingerprintSha256 = readNonEmptyText(row.fingerprintSha256, "fingerprint");
  const patchSha256 = readNonEmptyText(row.patchSha256, "patch digest");
  return {
    id: readNonEmptyText(row.id, "permit ID"),
    incidentId: readNonEmptyText(row.incidentId, "permit incident ID"),
    recoveryAttemptId: readNonEmptyText(
      row.recoveryAttemptId,
      "permit recovery attempt ID",
    ),
    fingerprintSha256,
    patchSha256,
    deploymentTarget,
    state: readPermitState(row.state),
    approvedAt: readNonEmptyText(row.approvedAt, "permit approval timestamp"),
    consumedAt: readNullableText(row.consumedAt, "permit consumption timestamp"),
    createdAt: readNonEmptyText(row.createdAt, "permit creation timestamp"),
  };
}

function mapDeployment(row: DeploymentRow): RecoveryDeployment {
  const deploymentTarget = readNonEmptyText(row.deploymentTarget, "deployment target");
  if (deploymentTarget !== DEPLOYMENT_TARGET) {
    throw new Error("The recovery deployment target is invalid.");
  }
  return {
    id: readNonEmptyText(row.id, "deployment ID"),
    incidentId: readNonEmptyText(row.incidentId, "deployment incident ID"),
    recoveryAttemptId: readNonEmptyText(
      row.recoveryAttemptId,
      "deployment recovery attempt ID",
    ),
    deployPermitId: readNonEmptyText(row.deployPermitId, "deployment permit ID"),
    patchSha256: readNonEmptyText(row.patchSha256, "deployment patch digest"),
    deploymentTarget,
    state: readDeploymentState(row.state),
    preDeployMutationCount: readNullableNonNegativeInteger(
      row.preDeployMutationCount,
      "pre-deploy mutation count",
    ),
    postDeployMutationCount: readNullableNonNegativeInteger(
      row.postDeployMutationCount,
      "post-deploy mutation count",
    ),
    healthStatusCode: readNullableNonNegativeInteger(
      row.healthStatusCode,
      "health status code",
    ),
    startedAt: readNullableText(row.startedAt, "deployment start timestamp"),
    completedAt: readNullableText(row.completedAt, "deployment completion timestamp"),
    createdAt: readNonEmptyText(row.createdAt, "deployment creation timestamp"),
    updatedAt: readNonEmptyText(row.updatedAt, "deployment update timestamp"),
  };
}

function serializeCandidate(candidate: DeploymentCandidate): string {
  return JSON.stringify({
    schemaVersion: candidate.schemaVersion,
    kind: candidate.kind,
    incidentId: candidate.incidentId,
    recoveryAttemptId: candidate.recoveryAttemptId,
    sourceRepositoryFullName: candidate.sourceRepositoryFullName,
    originalRevision: candidate.originalRevision,
    patchSha256: candidate.patchSha256,
    deploymentTarget: candidate.deploymentTarget,
  });
}

export function buildDeploymentCandidate(input: {
  incidentId: string;
  recoveryAttemptId: string;
  sourceRepositoryFullName: string;
  originalRevision: string;
  patchSha256: string;
}): DeploymentCandidate {
  if (!isSha256(input.patchSha256)) {
    throw new DeploymentNotEligibleError("The recovery patch digest is invalid.");
  }
  return {
    schemaVersion: DEPLOYMENT_SCHEMA_VERSION,
    kind: DEPLOYMENT_KIND,
    incidentId: input.incidentId,
    recoveryAttemptId: input.recoveryAttemptId,
    sourceRepositoryFullName: input.sourceRepositoryFullName,
    originalRevision: input.originalRevision,
    patchSha256: input.patchSha256,
    deploymentTarget: DEPLOYMENT_TARGET,
  };
}

export function serializeDeploymentCandidateForFingerprint(
  candidate: DeploymentCandidate,
): string {
  return serializeCandidate(candidate);
}

export function computeDeploymentFingerprint(
  candidate: DeploymentCandidate,
): string {
  return sha256(serializeCandidate(candidate));
}

function rowToRecoveryAttempt(row: RecoveryAttemptRow): RecoveryAttemptArtifact | null {
  if (
    typeof row.id !== "string" ||
    typeof row.incidentId !== "string" ||
    typeof row.state !== "string" ||
    typeof row.sourceRepositoryFullName !== "string" ||
    typeof row.originalRevision !== "string" ||
    typeof row.deliveryGuid !== "string" ||
    typeof row.patchText !== "string" ||
    typeof row.patchSha256 !== "string" ||
    typeof row.verificationPreCount !== "number" ||
    typeof row.verificationHttpStatus !== "number" ||
    typeof row.verificationPostCount !== "number"
  ) {
    return null;
  }
  return {
    id: row.id,
    incidentId: row.incidentId,
    state: row.state,
    sourceRepositoryFullName: row.sourceRepositoryFullName,
    originalRevision: row.originalRevision,
    deliveryGuid: row.deliveryGuid,
    patchText: row.patchText,
    patchSha256: row.patchSha256,
    verificationPreCount: row.verificationPreCount,
    verificationHttpStatus: row.verificationHttpStatus,
    verificationPostCount: row.verificationPostCount,
  };
}

function readCurrentCandidate(
  database: SqliteDatabase,
  incidentId: string,
): CandidateRead {
  let rows: RecoveryAttemptRow[];
  try {
    rows = database.all<RecoveryAttemptRow>(
      `SELECT ${recoveryAttemptColumns}
         FROM recovery_attempts
        WHERE incident_id = ?
        ORDER BY id ASC`,
      [incidentId],
    );
  } catch (error) {
    if (error instanceof Error && /no such table: recovery_attempts/.test(error.message)) {
      throw new DeploymentConfigurationError(
        "The recovery_attempts prerequisite is not available.",
      );
    }
    throw error;
  }

  const attempts = rows.map(rowToRecoveryAttempt);
  const verified = attempts.filter(
    (attempt): attempt is RecoveryAttemptArtifact =>
      attempt !== null && attempt.state === "REPAIR_VERIFIED",
  );
  if (verified.length === 0) {
    return {
      artifact: null,
      candidate: null,
      reason: "A REPAIR_VERIFIED recovery attempt is required.",
    };
  }
  if (verified.length > 1) {
    return {
      artifact: null,
      candidate: null,
      reason: "More than one REPAIR_VERIFIED recovery attempt is ambiguous.",
    };
  }

  const artifact = verified[0];
  if (
    artifact.incidentId !== incidentId ||
    artifact.sourceRepositoryFullName.trim().length === 0 ||
    artifact.originalRevision.trim().length === 0 ||
    artifact.deliveryGuid.trim().length === 0
  ) {
    return {
      artifact: null,
      candidate: null,
      reason: "The REPAIR_VERIFIED recovery artifact is incomplete.",
    };
  }
  if (artifact.patchText.length === 0) {
    return {
      artifact: null,
      candidate: null,
      reason: "The verified repair patch is empty.",
    };
  }
  if (!isSha256(artifact.patchSha256)) {
    return {
      artifact: null,
      candidate: null,
      reason: "The persisted repair patch digest is invalid.",
    };
  }
  if (sha256(artifact.patchText) !== artifact.patchSha256) {
    return {
      artifact: null,
      candidate: null,
      reason: "The persisted repair patch digest does not match patch_text.",
    };
  }
  if (
    artifact.verificationPreCount !== 1 ||
    artifact.verificationHttpStatus < 200 ||
    artifact.verificationHttpStatus >= 300 ||
    artifact.verificationPostCount !== 1
  ) {
    return {
      artifact: null,
      candidate: null,
      reason: "The repair verification invariant is not exactly one mutation with a 2xx response.",
    };
  }
  try {
    const candidate = buildDeploymentCandidate({
      incidentId,
      recoveryAttemptId: artifact.id,
      sourceRepositoryFullName: artifact.sourceRepositoryFullName,
      originalRevision: artifact.originalRevision,
      patchSha256: artifact.patchSha256,
    });
    return { artifact, candidate, reason: null };
  } catch (error) {
    return {
      artifact: null,
      candidate: null,
      reason: error instanceof Error ? error.message : "The candidate is invalid.",
    };
  }
}

function readPermitById(
  database: SqliteDatabase,
  permitId: string,
): DeploymentPermit | null {
  const row = database.get<PermitRow>(
    `SELECT ${permitColumns} FROM deploy_permits WHERE id = ?`,
    [permitId],
  );
  return row === undefined ? null : mapPermit(row);
}

function readPermitByFingerprint(
  database: SqliteDatabase,
  fingerprint: string,
): DeploymentPermit | null {
  const row = database.get<PermitRow>(
    `SELECT ${permitColumns}
       FROM deploy_permits
      WHERE fingerprint_sha256 = ?`,
    [fingerprint],
  );
  return row === undefined ? null : mapPermit(row);
}

function readLatestPermit(
  database: SqliteDatabase,
  incidentId: string,
): DeploymentPermit | null {
  const row = database.get<PermitRow>(
    `SELECT ${permitColumns}
       FROM deploy_permits
      WHERE incident_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [incidentId],
  );
  return row === undefined ? null : mapPermit(row);
}

function readDeploymentByPermit(
  database: SqliteDatabase,
  permitId: string,
): RecoveryDeployment | null {
  const row = database.get<DeploymentRow>(
    `SELECT ${deploymentColumns}
       FROM recovery_deployments
      WHERE deploy_permit_id = ?`,
    [permitId],
  );
  return row === undefined ? null : mapDeployment(row);
}

function readLatestDeployment(
  database: SqliteDatabase,
  incidentId: string,
): RecoveryDeployment | null {
  const row = database.get<DeploymentRow>(
    `SELECT ${deploymentColumns}
       FROM recovery_deployments
      WHERE incident_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [incidentId],
  );
  return row === undefined ? null : mapDeployment(row);
}

function requireIncident(
  database: SqliteDatabase,
  incidentId: string,
) {
  const incident = createIncidentService(database).getById(incidentId);
  if (incident === null) {
    throw new DeploymentNotFoundError("The incident was not found.");
  }
  return incident;
}

function requireEligibleCandidate(
  database: SqliteDatabase,
  incidentId: string,
): CandidateRead & { artifact: RecoveryAttemptArtifact; candidate: DeploymentCandidate } {
  const current = readCurrentCandidate(database, incidentId);
  if (current.artifact === null || current.candidate === null) {
    throw new DeploymentNotEligibleError(
      current.reason ?? "The incident is not eligible for deployment.",
    );
  }
  return current as CandidateRead & {
    artifact: RecoveryAttemptArtifact;
    candidate: DeploymentCandidate;
  };
}

function getConfiguredDemoReceiverRepoPath(
  environment: NodeJS.ProcessEnv,
): string {
  const configured = environment.REDRIVE_DEMO_RECEIVER_REPO_PATH;
  if (typeof configured !== "string" || configured.length === 0) {
    throw new DeploymentConfigurationError(
      "REDRIVE_DEMO_RECEIVER_REPO_PATH must be configured.",
    );
  }
  if (configured !== configured.trim()) {
    throw new DeploymentConfigurationError(
      "REDRIVE_DEMO_RECEIVER_REPO_PATH must not have surrounding whitespace.",
    );
  }
  if (!path.isAbsolute(configured)) {
    throw new DeploymentConfigurationError(
      "REDRIVE_DEMO_RECEIVER_REPO_PATH must be an absolute path.",
    );
  }
  return path.normalize(path.resolve(configured));
}

export function getDemoReceiverDeploymentConfiguration(
  environment: NodeJS.ProcessEnv = process.env,
): { repositoryPath: string; deploymentTarget: typeof DEPLOYMENT_TARGET } {
  return {
    repositoryPath: getConfiguredDemoReceiverRepoPath(environment),
    deploymentTarget: DEPLOYMENT_TARGET,
  };
}

function assertDirectory(repositoryPath: string): void {
  if (!existsSync(repositoryPath)) {
    throw new DeploymentPreconditionError("The configured receiver repository does not exist.");
  }
  try {
    if (!statSync(repositoryPath).isDirectory()) {
      throw new DeploymentPreconditionError(
        "The configured receiver repository path is not a directory.",
      );
    }
  } catch (error) {
    if (error instanceof DeploymentPreconditionError) throw error;
    throw new DeploymentPreconditionError(
      "The configured receiver repository could not be inspected.",
    );
  }
}

function assertComposeFile(repositoryPath: string): string {
  const composePath = path.join(repositoryPath, "compose.yaml");
  try {
    if (!statSync(composePath).isFile()) {
      throw new DeploymentPreconditionError("The receiver compose.yaml is not a file.");
    }
  } catch (error) {
    if (error instanceof DeploymentPreconditionError) throw error;
    throw new DeploymentPreconditionError("The receiver compose.yaml could not be found.");
  }
  return composePath;
}

function assertCommandResult(
  result: CommandResult,
  executable: string,
): CommandResult {
  if (
    result === null ||
    typeof result !== "object" ||
    !Number.isSafeInteger(result.exitCode) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    throw new DeploymentCommandFailure(
      `${executable} returned an invalid command result.`,
      "AMBIGUOUS",
    );
  }
  if (result.exitCode !== 0) {
    throw new DeploymentCommandFailure(
      `${executable} exited with status ${result.exitCode}.`,
      "DEFINITE_FAILURE",
      result.exitCode,
    );
  }
  return result;
}

async function runFixedCommand(
  runner: DeploymentCommandRunner,
  executable: string,
  args: readonly string[],
  options: CommandRunOptions,
): Promise<CommandResult> {
  try {
    return assertCommandResult(await runner.run(executable, args, options), executable);
  } catch (error) {
    if (error instanceof DeploymentCommandFailure) throw error;
    throw new DeploymentCommandFailure(
      error instanceof Error ? error.message : `${executable} execution failed.`,
      "AMBIGUOUS",
    );
  }
}

function createNodeCommandRunner(): DeploymentCommandRunner {
  return {
    run(executable, args, options) {
      return new Promise((resolve, reject) => {
        execFile(
          executable,
          [...args],
          { cwd: options.cwd, shell: false, maxBuffer: 1024 * 1024 },
          (error, stdout, stderr) => {
            if (error !== null) {
              const code = typeof error.code === "number" ? error.code : null;
              const definitelyNotStarted = error.code === "ENOENT";
              reject(
                new DeploymentCommandFailure(
                  `${executable} failed: ${error.message}`,
                  definitelyNotStarted || code !== null
                    ? "DEFINITE_FAILURE"
                    : "AMBIGUOUS",
                  code,
                ),
              );
              return;
            }
            resolve({ exitCode: 0, stdout, stderr });
          },
        );
      });
    },
  };
}

function createDefaultHealthCheck(
  requestTimeoutMs = 2_000,
): (url: string) => Promise<number> {
  return async (url) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, {
        method: "GET",
        cache: "no-store",
        signal: controller.signal,
      });
      return response.status;
    } finally {
      clearTimeout(timer);
    }
  };
}

function createDefaultReceiverStateReader(
  database: SqliteDatabase,
  environment: NodeJS.ProcessEnv,
): ReceiverBusinessStateReader {
  const server = createReceiverMcpServer({
    environment,
    getServices: () => ({
      database,
      connections: createReceiverConnectionService({ database }),
      jobs: createReceiverReadJobTransportService({ database }),
    }),
  });

  return {
    async readBusinessState({ applicationConnectionId, deliveryGuid }) {
      const response = await server.handleRequest(
        new Request("http://redrive.internal/api/mcp/receiver", {
          method: "POST",
          headers: {
            authorization: `Bearer ${environment.REDRIVE_RECEIVER_MCP_TOKEN ?? ""}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: "deploy-receiver-read",
            method: "tools/call",
            params: {
              name: "get_business_state",
              arguments: {
                connection_id: applicationConnectionId,
                delivery_guid: deliveryGuid,
              },
            },
          }),
        }),
      );
      if (response.status !== 200) {
        throw new Error("The typed receiver state read was unavailable.");
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const result = payload.result;
      if (result === null || typeof result !== "object") {
        throw new Error("The typed receiver state response was malformed.");
      }
      const content = (result as Record<string, unknown>).content;
      if (
        !Array.isArray(content) ||
        content.length !== 1 ||
        content[0] === null ||
        typeof content[0] !== "object" ||
        typeof (content[0] as Record<string, unknown>).text !== "string"
      ) {
        throw new Error("The typed receiver state response was malformed.");
      }
      if ((result as Record<string, unknown>).isError === true) {
        throw new Error("The typed receiver state read failed.");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse((content[0] as Record<string, unknown>).text as string);
      } catch {
        throw new Error("The typed receiver state response was not JSON.");
      }
      return parseBusinessStateReadResult(parsed, deliveryGuid);
    },
  };
}

function assertExactBusinessState(
  result: Pick<BusinessStateReadResult, "mutationCount" | "businessState">,
  phase: string,
): void {
  if (result.mutationCount !== 1 || result.businessState !== "EXACTLY_ONE") {
    throw new DeploymentPreconditionError(
      `${phase} receiver state must be mutationCount 1 and EXACTLY_ONE.`,
    );
  }
}

function writePatchFile(
  temporaryDirectory: string,
  patchText: string,
): { directory: string; filePath: string } {
  const directory = mkdtempSync(path.join(temporaryDirectory, "redrive-deploy-"));
  const filePath = path.join(directory, `${randomUUID()}.patch`);
  writeFileSync(filePath, patchText, { encoding: "utf8", mode: 0o600, flag: "wx" });
  return { directory, filePath };
}

function cleanupPatchFile(file: { directory: string; filePath: string }): void {
  rmSync(file.directory, { recursive: true, force: true });
}

function prepareTarget(
  runner: DeploymentCommandRunner,
  repositoryPath: string,
  composePath: string,
  artifact: RecoveryAttemptArtifact,
  temporaryDirectory: string,
): Promise<{ patchFile: { directory: string; filePath: string }; composePath: string }> {
  assertDirectory(repositoryPath);
  assertComposeFile(repositoryPath);
  const patchFile = writePatchFile(temporaryDirectory, artifact.patchText);
  return (async () => {
    try {
      const root = await runFixedCommand(
        runner,
        "git",
        ["-C", repositoryPath, "rev-parse", "--show-toplevel"],
        { cwd: repositoryPath },
      );
      if (path.normalize(path.resolve(root.stdout.trim())) !== repositoryPath) {
        throw new DeploymentPreconditionError(
          "The configured path is not the expected Git repository root.",
        );
      }

      const head = await runFixedCommand(
        runner,
        "git",
        ["-C", repositoryPath, "rev-parse", "HEAD"],
        { cwd: repositoryPath },
      );
      if (head.stdout.trim() !== artifact.originalRevision) {
        throw new DeploymentPreconditionError(
          "The receiver repository HEAD does not match the original revision.",
        );
      }

      const status = await runFixedCommand(
        runner,
        "git",
        ["-C", repositoryPath, "status", "--porcelain"],
        { cwd: repositoryPath },
      );
      if (status.stdout.length !== 0) {
        throw new DeploymentPreconditionError(
          "The receiver repository worktree is dirty.",
        );
      }

      await runFixedCommand(
        runner,
        "git",
        ["-C", repositoryPath, "apply", "--check", patchFile.filePath],
        { cwd: repositoryPath },
      );
      return { patchFile, composePath };
    } catch (error) {
      cleanupPatchFile(patchFile);
      if (error instanceof DeploymentPreconditionError) throw error;
      throw new DeploymentPreconditionError(
        error instanceof Error ? error.message : "The deployment preflight failed.",
      );
    }
  })();
}

function insertPreparedDeployment(
  database: SqliteDatabase,
  incidentId: string,
  permitId: string,
  expectedFingerprint: string,
  preDeployMutationCount: number,
  timestamp: string,
): RecoveryDeployment {
  return database.transaction(() => {
    const current = requireEligibleCandidate(database, incidentId);
    const permit = readPermitById(database, permitId);
    if (permit === null) {
      throw new DeploymentPermitError("The deployment permit was not found.");
    }
    if (permit.state !== "APPROVED") {
      throw new DeploymentPermitError("The deployment permit is no longer approved.");
    }
    if (
      permit.incidentId !== incidentId ||
      permit.recoveryAttemptId !== current.candidate.recoveryAttemptId ||
      permit.patchSha256 !== current.candidate.patchSha256 ||
      permit.fingerprintSha256 !== expectedFingerprint ||
      permit.fingerprintSha256 !== computeDeploymentFingerprint(current.candidate)
    ) {
      throw new DeploymentFingerprintMismatchError();
    }

    const existing = readDeploymentByPermit(database, permitId);
    if (existing !== null) throw new DeploymentAlreadyAttemptedError(existing);

    const deploymentId = randomUUID();
    const insertion = database.run(
      `INSERT INTO recovery_deployments (
         id, incident_id, recovery_attempt_id, deploy_permit_id,
         patch_sha256, deployment_target, state,
         pre_deploy_mutation_count, post_deploy_mutation_count,
         health_status_code, started_at, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'PREPARED', ?, NULL, NULL, ?, NULL, ?, ?)`,
      [
        deploymentId,
        incidentId,
        current.candidate.recoveryAttemptId,
        permit.id,
        current.candidate.patchSha256,
        DEPLOYMENT_TARGET,
        preDeployMutationCount,
        timestamp,
        timestamp,
        timestamp,
      ],
    );
    if (insertion.changes !== 1) {
      throw new Error("The recovery deployment could not be prepared.");
    }

    const consumed = database.run(
      `UPDATE deploy_permits
          SET state = 'CONSUMED', consumed_at = ?
        WHERE id = ? AND state = 'APPROVED'`,
      [timestamp, permit.id],
    );
    if (consumed.changes !== 1) {
      throw new DeploymentPermitError("The deployment permit could not be consumed.");
    }
    const row = database.get<DeploymentRow>(
      `SELECT ${deploymentColumns} FROM recovery_deployments WHERE id = ?`,
      [deploymentId],
    );
    if (row === undefined) throw new Error("The prepared deployment could not be read.");
    return mapDeployment(row);
  }, "immediate");
}

function updateDeploymentOutcome(
  database: SqliteDatabase,
  deploymentId: string,
  from: "APPLYING" | "VERIFYING",
  state: "FAILED" | "OUTCOME_UNKNOWN" | "VERIFIED",
  now: string,
  postDeployMutationCount: number | null,
  healthStatusCode: number | null,
): RecoveryDeployment {
  const update = database.run(
    `UPDATE recovery_deployments
        SET state = ?,
            post_deploy_mutation_count = ?,
            health_status_code = ?,
            completed_at = ?,
            updated_at = ?
      WHERE id = ? AND state = ?`,
    [
      state,
      postDeployMutationCount,
      healthStatusCode,
      now,
      now,
      deploymentId,
      from,
    ],
  );
  if (update.changes !== 1) {
    throw new Error("The deployment outcome could not be persisted.");
  }
  const row = database.get<DeploymentRow>(
    `SELECT ${deploymentColumns} FROM recovery_deployments WHERE id = ?`,
    [deploymentId],
  );
  if (row === undefined) throw new Error("The deployment outcome could not be read.");
  return mapDeployment(row);
}

async function defaultSleep(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

export function createRecoveryDeploymentService(options: DeploymentServiceOptions) {
  const environment = options.environment ?? process.env;
  const runner = options.commandRunner ?? createNodeCommandRunner();
  const receiverStateReader =
    options.receiverStateReader ??
    createDefaultReceiverStateReader(options.database, environment);
  const temporaryDirectory = options.temporaryDirectory ?? os.tmpdir();
  const healthCheck = options.healthCheck ?? createDefaultHealthCheck();
  const healthPollCount = options.healthPollCount ?? 30;
  const healthPollIntervalMs = options.healthPollIntervalMs ?? 1_000;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => new Date().toISOString());

  function getStatus(incidentId: string): DeploymentStatus {
    const incident = requireIncident(options.database, incidentId);
    const current = readCurrentCandidate(options.database, incident.id);
    const candidate = current.candidate;
    return {
      incidentId: incident.id,
      eligible: candidate !== null,
      reason: current.reason,
      candidate,
      fingerprint: candidate === null ? null : computeDeploymentFingerprint(candidate),
      permit: readLatestPermit(options.database, incident.id),
      deployment: readLatestDeployment(options.database, incident.id),
    };
  }

  function approvePermit(
    incidentId: string,
    submittedFingerprint: string,
  ): DeploymentPermit {
    if (!isSha256(submittedFingerprint)) {
      throw new DeploymentFingerprintMismatchError();
    }
    requireIncident(options.database, incidentId);
    return options.database.transaction(() => {
      const current = requireEligibleCandidate(options.database, incidentId);
      const expectedFingerprint = computeDeploymentFingerprint(current.candidate);
      if (submittedFingerprint !== expectedFingerprint) {
        throw new DeploymentFingerprintMismatchError();
      }
      const existing = readPermitByFingerprint(options.database, expectedFingerprint);
      if (existing !== null) {
        if (
          existing.incidentId !== incidentId ||
          existing.recoveryAttemptId !== current.candidate.recoveryAttemptId
        ) {
          throw new DeploymentPermitError(
            "The fingerprint is already bound to a different deployment candidate.",
          );
        }
        return existing;
      }
      const timestamp = now();
      const id = randomUUID();
      const insertion = options.database.run(
        `INSERT INTO deploy_permits (
           id, incident_id, recovery_attempt_id, fingerprint_sha256,
           patch_sha256, deployment_target, state, approved_at, consumed_at,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'APPROVED', ?, NULL, ?)`,
        [
          id,
          incidentId,
          current.candidate.recoveryAttemptId,
          expectedFingerprint,
          current.candidate.patchSha256,
          DEPLOYMENT_TARGET,
          timestamp,
          timestamp,
        ],
      );
      if (insertion.changes !== 1) {
        throw new Error("The deployment permit could not be persisted.");
      }
      const permit = readPermitById(options.database, id);
      if (permit === null) throw new Error("The deployment permit could not be read.");
      return permit;
    }, "immediate");
  }

  async function deploy(
    incidentId: string,
    permitId: string,
  ): Promise<RecoveryDeployment> {
    const incident = requireIncident(options.database, incidentId);
    const permit = readPermitById(options.database, permitId);
    if (permit === null) throw new DeploymentNotFoundError("The deployment permit was not found.");
    const existing = readDeploymentByPermit(options.database, permit.id);
    if (existing !== null) {
      if (
        existing.state === "APPLYING" ||
        existing.state === "VERIFYING" ||
        existing.state === "OUTCOME_UNKNOWN" ||
        existing.state === "PREPARED"
      ) {
        throw new DeploymentReconciliationRequiredError(existing);
      }
      throw new DeploymentAlreadyAttemptedError(existing);
    }
    if (permit.state !== "APPROVED") {
      throw new DeploymentPermitError("The deployment permit is not approved.");
    }
    if (permit.incidentId !== incident.id) {
      throw new DeploymentPermitError("The deployment permit belongs to a different incident.");
    }

    const current = requireEligibleCandidate(options.database, incident.id);
    const connectionId = incident.applicationConnectionId;
    if (connectionId === undefined) {
      throw new DeploymentPreconditionError(
        "The incident has no persisted application connection.",
      );
    }
    const connection = getApplicationConnection(options.database, connectionId);
    if (connection === null) {
      throw new DeploymentPreconditionError("The incident application connection is unavailable.");
    }
    if (connection.repositoryFullName !== current.candidate.sourceRepositoryFullName) {
      throw new DeploymentPreconditionError(
        "The recovery repository does not match the incident application connection.",
      );
    }
    const fingerprint = computeDeploymentFingerprint(current.candidate);
    if (
      permit.recoveryAttemptId !== current.candidate.recoveryAttemptId ||
      permit.patchSha256 !== current.candidate.patchSha256 ||
      permit.fingerprintSha256 !== fingerprint ||
      permit.deploymentTarget !== DEPLOYMENT_TARGET
    ) {
      throw new DeploymentFingerprintMismatchError();
    }

    const target = getDemoReceiverDeploymentConfiguration(environment);
    let preState: Pick<BusinessStateReadResult, "mutationCount" | "businessState">;
    try {
      preState = await receiverStateReader.readBusinessState({
        applicationConnectionId: connection.id,
        deliveryGuid: current.artifact.deliveryGuid,
      });
    } catch (error) {
      throw new DeploymentPreconditionError(
        error instanceof Error ? error.message : "The pre-deploy receiver read failed.",
      );
    }
    assertExactBusinessState(preState, "Pre-deploy");

    const preparedTarget = await prepareTarget(
      runner,
      target.repositoryPath,
      assertComposeFile(target.repositoryPath),
      current.artifact,
      temporaryDirectory,
    );
    try {
      const prepared = insertPreparedDeployment(
        options.database,
        incident.id,
        permit.id,
        fingerprint,
        preState.mutationCount,
        now(),
      );

      // This durable transition is deliberately separate from git apply. If
      // the process dies after this commit, a retry sees APPLYING and is
      // blocked for manual reconciliation instead of applying twice.
      const applying = options.database.transaction(() => {
        const update = options.database.run(
          `UPDATE recovery_deployments
              SET state = 'APPLYING', updated_at = ?
            WHERE id = ? AND state = 'PREPARED'`,
          [now(), prepared.id],
        );
        if (update.changes !== 1) {
          throw new DeploymentReconciliationRequiredError(prepared);
        }
        const row = options.database.get<DeploymentRow>(
          `SELECT ${deploymentColumns} FROM recovery_deployments WHERE id = ?`,
          [prepared.id],
        );
        if (row === undefined) throw new Error("The applying deployment could not be read.");
        return mapDeployment(row);
      }, "immediate");

      // Re-read the durable artifact after the APPLYING commit and before the
      // consequential command. A repair update racing this boundary makes the
      // attempt manual-reconciliation-only; it must never cause an old patch
      // file to be applied against a new candidate.
      try {
        const latest = requireEligibleCandidate(options.database, incident.id);
        if (
          latest.candidate.recoveryAttemptId !== current.candidate.recoveryAttemptId ||
          latest.candidate.sourceRepositoryFullName !== current.candidate.sourceRepositoryFullName ||
          latest.candidate.originalRevision !== current.candidate.originalRevision ||
          latest.candidate.patchSha256 !== current.candidate.patchSha256 ||
          computeDeploymentFingerprint(latest.candidate) !== fingerprint ||
          latest.artifact.patchText !== current.artifact.patchText
        ) {
          throw new Error("The durable repair artifact changed before apply.");
        }
      } catch {
        throw new DeploymentReconciliationRequiredError(applying);
      }

      try {
        await runFixedCommand(
          runner,
          "git",
          ["-C", target.repositoryPath, "apply", preparedTarget.patchFile.filePath],
          { cwd: target.repositoryPath },
        );
      } catch (error) {
        if (error instanceof DeploymentCommandFailure && error.outcome === "DEFINITE_FAILURE") {
          const failed = updateDeploymentOutcome(
            options.database,
            applying.id,
            "APPLYING",
            "FAILED",
            now(),
            null,
            null,
          );
          throw new DeploymentExecutionError(failed, error.message);
        }
        const unknown = updateDeploymentOutcome(
          options.database,
          applying.id,
          "APPLYING",
          "OUTCOME_UNKNOWN",
          now(),
          null,
          null,
        );
        throw new DeploymentOutcomeUnknownError(unknown, error instanceof Error ? error.message : undefined);
      }

      let verifying: RecoveryDeployment;
      try {
        const update = options.database.run(
          `UPDATE recovery_deployments
              SET state = 'VERIFYING', updated_at = ?
            WHERE id = ? AND state = 'APPLYING'`,
          [now(), applying.id],
        );
        if (update.changes !== 1) throw new Error("The verifying transition was not persisted.");
        const row = options.database.get<DeploymentRow>(
          `SELECT ${deploymentColumns} FROM recovery_deployments WHERE id = ?`,
          [applying.id],
        );
        if (row === undefined) throw new Error("The verifying deployment could not be read.");
        verifying = mapDeployment(row);
      } catch (error) {
        throw new DeploymentOutcomeUnknownError(
          applying,
          error instanceof Error ? error.message : undefined,
        );
      }

      try {
        await runFixedCommand(
          runner,
          "docker",
          ["compose", "-f", preparedTarget.composePath, "up", "--build", "-d"],
          { cwd: target.repositoryPath },
        );
      } catch (error) {
        if (error instanceof DeploymentCommandFailure && error.outcome === "DEFINITE_FAILURE") {
          const failed = updateDeploymentOutcome(
            options.database,
            verifying.id,
            "VERIFYING",
            "FAILED",
            now(),
            null,
            null,
          );
          throw new DeploymentExecutionError(failed, error.message);
        }
        const unknown = updateDeploymentOutcome(
          options.database,
          verifying.id,
          "VERIFYING",
          "OUTCOME_UNKNOWN",
          now(),
          null,
          null,
        );
        throw new DeploymentOutcomeUnknownError(unknown, error instanceof Error ? error.message : undefined);
      }

      let healthStatusCode: number | null = null;
      try {
        for (let poll = 0; poll < healthPollCount; poll += 1) {
          const statusCode = await healthCheck(DEPLOYMENT_HEALTH_URL);
          if (!Number.isSafeInteger(statusCode) || statusCode < 100 || statusCode > 599) {
            throw new Error("The health check returned an invalid status code.");
          }
          healthStatusCode = statusCode;
          if (statusCode === 200) break;
          if (poll + 1 < healthPollCount) await sleep(healthPollIntervalMs);
        }
      } catch (error) {
        const unknown = updateDeploymentOutcome(
          options.database,
          verifying.id,
          "VERIFYING",
          "OUTCOME_UNKNOWN",
          now(),
          null,
          healthStatusCode,
        );
        throw new DeploymentOutcomeUnknownError(unknown, error instanceof Error ? error.message : undefined);
      }
      if (healthStatusCode !== 200) {
        const failed = updateDeploymentOutcome(
          options.database,
          verifying.id,
          "VERIFYING",
          "FAILED",
          now(),
          null,
          healthStatusCode,
        );
        throw new DeploymentVerificationError(
          failed,
          "The deployed receiver health endpoint did not return HTTP 200.",
        );
      }

      let postState: Pick<BusinessStateReadResult, "mutationCount" | "businessState">;
      try {
        postState = await receiverStateReader.readBusinessState({
          applicationConnectionId: connection.id,
          deliveryGuid: current.artifact.deliveryGuid,
        });
      } catch (error) {
        const unknown = updateDeploymentOutcome(
          options.database,
          verifying.id,
          "VERIFYING",
          "OUTCOME_UNKNOWN",
          now(),
          null,
          200,
        );
        throw new DeploymentOutcomeUnknownError(unknown, error instanceof Error ? error.message : undefined);
      }
      if (postState.mutationCount !== 1 || postState.businessState !== "EXACTLY_ONE") {
        const failed = updateDeploymentOutcome(
          options.database,
          verifying.id,
          "VERIFYING",
          "FAILED",
          now(),
          postState.mutationCount,
          200,
        );
        throw new DeploymentVerificationError(
          failed,
          "The post-deploy receiver state is not exactly one mutation.",
        );
      }

      return updateDeploymentOutcome(
        options.database,
        verifying.id,
        "VERIFYING",
        "VERIFIED",
        now(),
        1,
        200,
      );
    } finally {
      cleanupPatchFile(preparedTarget.patchFile);
    }
  }

  return { getStatus, approvePermit, deploy };
}

type RecoveryDeploymentService = ReturnType<typeof createRecoveryDeploymentService>;

function withConfiguredService<T>(
  operation: (service: RecoveryDeploymentService) => T,
): T {
  const config = getServerConfig();
  const database = getConfiguredDatabase(config.databasePath);
  return operation(createRecoveryDeploymentService({ database }));
}

export function getDeploymentStatusForIncident(
  incidentId: string,
): DeploymentStatus {
  return withConfiguredService((service) => service.getStatus(incidentId));
}

export function approveDeploymentPermit(
  incidentId: string,
  fingerprint: string,
): DeploymentPermit {
  return withConfiguredService((service) => service.approvePermit(incidentId, fingerprint));
}

export async function deployRecovery(
  incidentId: string,
  permitId: string,
): Promise<RecoveryDeployment> {
  return withConfiguredService((service) => service.deploy(incidentId, permitId));
}
