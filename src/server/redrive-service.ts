import { randomUUID } from "node:crypto";
import {
  computeRedriveFingerprintSha256,
  REDRIVE_DEPLOYMENT_TARGET,
  serializeRedriveFingerprint,
  type RedriveDispatchState,
  type RedriveFingerprintInput,
  type RedrivePermitState,
} from "@/domain/redrive";
import {
  parseBusinessStateReadResult,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";
import type { Incident } from "@/domain/incident";
import {
  getConfiguredDatabase,
  type SqliteDatabase,
} from "@/server/database";
import { getServerConfig } from "@/server/config";
import {
  getApplicationConnection,
  parseGithubWebhookDelivery,
  type GithubWebhookDeliveryChoice,
} from "@/server/github-connection-service";
import { createGithubDeliveryService } from "@/server/github-delivery-service";
import { GithubRestError } from "@/server/github-rest";
import {
  createTypedReceiverBusinessStateReader,
  type ReceiverBusinessStateReader,
} from "@/server/receiver-final-observation";
import { createGithubApi } from "@/server/github-rest";
import { FilesystemSecretStore } from "@/server/secret-store";
import { createIncidentService } from "@/server/incident-service";

const HEX_64 = /^[a-f0-9]{64}$/;
const REDRIVE_SUCCESS_MIN = 200;
const REDRIVE_SUCCESS_MAX = 299;

export interface RedriveGithubService {
  redeliverWebhookDelivery(
    connectionId: string,
    deliveryId: string,
  ): Promise<number>;
  listWebhookDeliveryAttempts(connectionId: string): Promise<unknown[]>;
}

export interface RedrivePollingOptions {
  maxAttempts?: number;
  intervalMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export interface RedriveServiceOptions {
  database: SqliteDatabase;
  github: RedriveGithubService;
  receiver: ReceiverBusinessStateReader;
  now?: () => string;
  polling?: RedrivePollingOptions;
}

export function createConfiguredRedriveService() {
  const config = getServerConfig();
  const database = getConfiguredDatabase(config.databasePath);
  return createRedriveService({
    database,
    github: createGithubDeliveryService({
      database,
      api: createGithubApi(),
      secretStore: new FilesystemSecretStore(config.secretDir),
    }),
    receiver: createTypedReceiverBusinessStateReader({
      database,
      environment: process.env,
    }),
  });
}

export class RedriveError extends Error {
  readonly code:
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "INELIGIBLE"
    | "FINGERPRINT_MISMATCH"
    | "PERMIT_CONFLICT"
    | "PERMIT_NOT_FOUND"
    | "PRECONDITION_FAILED"
    | "PROVIDER_VERIFICATION_FAILED"
    | "RECEIVER_VERIFICATION_FAILED"
    | "OUTCOME_UNKNOWN";

  constructor(
    code: RedriveError["code"],
    message: string,
  ) {
    super(message);
    this.name = "RedriveError";
    this.code = code;
  }
}

export class RedriveRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RedriveRequestError";
  }
}

export interface RecoveryAttempt {
  id: string;
  incidentId: string;
  state: string;
  deliveryGuid: string;
  patchSha256: string;
  providerStatusCode: number;
  receiverPreCount: number;
  verificationPreCount: number;
  verificationHttpStatus: number;
  verificationPostCount: number;
  verifiedAt: string;
}

export interface RecoveryDeployment {
  id: string;
  incidentId: string;
  recoveryAttemptId: string;
  patchSha256: string;
  deploymentTarget: string;
  state: string;
  preDeployMutationCount: number;
  postDeployMutationCount: number;
  healthStatusCode: number;
  completedAt: string;
}

export interface RedrivePermit {
  id: string;
  incidentId: string;
  recoveryAttemptId: string;
  deploymentId: string;
  fingerprintSha256: string;
  patchSha256: string;
  providerDeliveryId: string;
  deliveryGuid: string;
  state: RedrivePermitState;
  approvedAt: string;
  consumedAt: string | null;
  createdAt: string;
}

export interface RedriveDispatch {
  id: string;
  incidentId: string;
  redrivePermitId: string;
  applicationConnectionId: string;
  originalDeliveryId: string;
  deliveryGuid: string;
  state: RedriveDispatchState;
  providerRedeliveryId: string | null;
  providerStatusCode: number | null;
  providerDeliveredAt: string | null;
  preRedriveMutationCount: number;
  finalMutationCount: number | null;
  startedAt: string | null;
  dispatchedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RecoveryReceipt {
  id: string;
  incidentId: string;
  recoveryAttemptId: string;
  deploymentId: string;
  dispatchId: string;
  originalProviderStatusCode: number;
  originalReceiverMutationCount: number;
  patchSha256: string;
  sandboxRetryStatusCode: number;
  sandboxRetryMutationCount: number;
  deploymentHealthStatusCode: number;
  preRedriveMutationCount: number;
  redeliveryProviderStatusCode: number;
  finalReceiverMutationCount: number;
  finalReceiverBusinessState: string;
  outcome: "RECOVERY_COMPLETE";
  receiptJson: string;
  createdAt: string;
}

interface RecoveryAttemptRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  state: unknown;
  deliveryGuid: unknown;
  patchSha256: unknown;
  providerStatusCode: unknown;
  receiverPreCount: unknown;
  verificationPreCount: unknown;
  verificationHttpStatus: unknown;
  verificationPostCount: unknown;
  verifiedAt: unknown;
}

interface RecoveryDeploymentRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  recoveryAttemptId: unknown;
  patchSha256: unknown;
  deploymentTarget: unknown;
  state: unknown;
  preDeployMutationCount: unknown;
  postDeployMutationCount: unknown;
  healthStatusCode: unknown;
  completedAt: unknown;
}

interface RedrivePermitRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  recoveryAttemptId: unknown;
  deploymentId: unknown;
  fingerprintSha256: unknown;
  patchSha256: unknown;
  providerDeliveryId: unknown;
  deliveryGuid: unknown;
  state: unknown;
  approvedAt: unknown;
  consumedAt: unknown;
  createdAt: unknown;
}

interface RedriveDispatchRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  redrivePermitId: unknown;
  applicationConnectionId: unknown;
  originalDeliveryId: unknown;
  deliveryGuid: unknown;
  state: unknown;
  providerRedeliveryId: unknown;
  providerStatusCode: unknown;
  providerDeliveredAt: unknown;
  preRedriveMutationCount: unknown;
  finalMutationCount: unknown;
  startedAt: unknown;
  dispatchedAt: unknown;
  completedAt: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface RecoveryReceiptRow extends Record<string, unknown> {
  id: unknown;
  incidentId: unknown;
  recoveryAttemptId: unknown;
  deploymentId: unknown;
  dispatchId: unknown;
  originalProviderStatusCode: unknown;
  originalReceiverMutationCount: unknown;
  patchSha256: unknown;
  sandboxRetryStatusCode: unknown;
  sandboxRetryMutationCount: unknown;
  deploymentHealthStatusCode: unknown;
  preRedriveMutationCount: unknown;
  redeliveryProviderStatusCode: unknown;
  finalReceiverMutationCount: unknown;
  finalReceiverBusinessState: unknown;
  outcome: unknown;
  receiptJson: unknown;
  createdAt: unknown;
}

const recoveryAttemptColumns = `
  id,
  incident_id AS incidentId,
  state,
  delivery_guid AS deliveryGuid,
  patch_sha256 AS patchSha256,
  provider_status_code AS providerStatusCode,
  receiver_pre_count AS receiverPreCount,
  verification_pre_count AS verificationPreCount,
  verification_http_status AS verificationHttpStatus,
  verification_post_count AS verificationPostCount,
  verified_at AS verifiedAt
`;

const recoveryDeploymentColumns = `
  id,
  incident_id AS incidentId,
  recovery_attempt_id AS recoveryAttemptId,
  patch_sha256 AS patchSha256,
  deployment_target AS deploymentTarget,
  state,
  pre_deploy_mutation_count AS preDeployMutationCount,
  post_deploy_mutation_count AS postDeployMutationCount,
  health_status_code AS healthStatusCode,
  completed_at AS completedAt
`;

const redrivePermitColumns = `
  id,
  incident_id AS incidentId,
  recovery_attempt_id AS recoveryAttemptId,
  deployment_id AS deploymentId,
  fingerprint_sha256 AS fingerprintSha256,
  patch_sha256 AS patchSha256,
  provider_delivery_id AS providerDeliveryId,
  delivery_guid AS deliveryGuid,
  state,
  approved_at AS approvedAt,
  consumed_at AS consumedAt,
  created_at AS createdAt
`;

const redriveDispatchColumns = `
  id,
  incident_id AS incidentId,
  redrive_permit_id AS redrivePermitId,
  application_connection_id AS applicationConnectionId,
  original_delivery_id AS originalDeliveryId,
  delivery_guid AS deliveryGuid,
  state,
  provider_redelivery_id AS providerRedeliveryId,
  provider_status_code AS providerStatusCode,
  provider_delivered_at AS providerDeliveredAt,
  pre_redrive_mutation_count AS preRedriveMutationCount,
  final_mutation_count AS finalMutationCount,
  started_at AS startedAt,
  dispatched_at AS dispatchedAt,
  completed_at AS completedAt,
  created_at AS createdAt,
  updated_at AS updatedAt
`;

const recoveryReceiptColumns = `
  id,
  incident_id AS incidentId,
  recovery_attempt_id AS recoveryAttemptId,
  deployment_id AS deploymentId,
  dispatch_id AS dispatchId,
  original_provider_status_code AS originalProviderStatusCode,
  original_receiver_mutation_count AS originalReceiverMutationCount,
  patch_sha256 AS patchSha256,
  sandbox_retry_status_code AS sandboxRetryStatusCode,
  sandbox_retry_mutation_count AS sandboxRetryMutationCount,
  deployment_health_status_code AS deploymentHealthStatusCode,
  pre_redrive_mutation_count AS preRedriveMutationCount,
  redelivery_provider_status_code AS redeliveryProviderStatusCode,
  final_receiver_mutation_count AS finalReceiverMutationCount,
  final_receiver_business_state AS finalReceiverBusinessState,
  outcome,
  receipt_json AS receiptJson,
  created_at AS createdAt
`;

function readText(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Redrive row has an invalid ${field} value.`);
  }
  return value;
}

function readNullableText(
  row: Record<string, unknown>,
  field: string,
): string | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Redrive row has an invalid ${field} value.`);
  }
  return value;
}

function readInteger(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Redrive row has an invalid ${field} value.`);
  }
  return value as number;
}

function readNullableInteger(
  row: Record<string, unknown>,
  field: string,
): number | null {
  const value = row[field];
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value)) {
    throw new Error(`Redrive row has an invalid ${field} value.`);
  }
  return value as number;
}

function readPermitState(value: unknown): RedrivePermitState {
  if (value !== "APPROVED" && value !== "CONSUMED" && value !== "REVOKED") {
    throw new Error("Redrive permit row has an invalid state.");
  }
  return value;
}

function readDispatchState(value: unknown): RedriveDispatchState {
  if (
    value !== "PREPARED" &&
    value !== "DISPATCHING" &&
    value !== "DISPATCHED" &&
    value !== "PROVIDER_VERIFIED" &&
    value !== "COMPLETE" &&
    value !== "FAILED" &&
    value !== "OUTCOME_UNKNOWN"
  ) {
    throw new Error("Redrive dispatch row has an invalid state.");
  }
  return value;
}

function mapRecoveryAttempt(row: RecoveryAttemptRow): RecoveryAttempt {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    state: readText(row, "state"),
    deliveryGuid: readText(row, "deliveryGuid"),
    patchSha256: readText(row, "patchSha256"),
    providerStatusCode: readInteger(row, "providerStatusCode"),
    receiverPreCount: readInteger(row, "receiverPreCount"),
    verificationPreCount: readInteger(row, "verificationPreCount"),
    verificationHttpStatus: readInteger(row, "verificationHttpStatus"),
    verificationPostCount: readInteger(row, "verificationPostCount"),
    verifiedAt: readText(row, "verifiedAt"),
  };
}

function mapRecoveryDeployment(row: RecoveryDeploymentRow): RecoveryDeployment {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    recoveryAttemptId: readText(row, "recoveryAttemptId"),
    patchSha256: readText(row, "patchSha256"),
    deploymentTarget: readText(row, "deploymentTarget"),
    state: readText(row, "state"),
    preDeployMutationCount: readInteger(row, "preDeployMutationCount"),
    postDeployMutationCount: readInteger(row, "postDeployMutationCount"),
    healthStatusCode: readInteger(row, "healthStatusCode"),
    completedAt: readText(row, "completedAt"),
  };
}

function mapPermit(row: RedrivePermitRow): RedrivePermit {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    recoveryAttemptId: readText(row, "recoveryAttemptId"),
    deploymentId: readText(row, "deploymentId"),
    fingerprintSha256: readText(row, "fingerprintSha256"),
    patchSha256: readText(row, "patchSha256"),
    providerDeliveryId: readText(row, "providerDeliveryId"),
    deliveryGuid: readText(row, "deliveryGuid"),
    state: readPermitState(row.state),
    approvedAt: readText(row, "approvedAt"),
    consumedAt: readNullableText(row, "consumedAt"),
    createdAt: readText(row, "createdAt"),
  };
}

function mapDispatch(row: RedriveDispatchRow): RedriveDispatch {
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    redrivePermitId: readText(row, "redrivePermitId"),
    applicationConnectionId: readText(row, "applicationConnectionId"),
    originalDeliveryId: readText(row, "originalDeliveryId"),
    deliveryGuid: readText(row, "deliveryGuid"),
    state: readDispatchState(row.state),
    providerRedeliveryId: readNullableText(row, "providerRedeliveryId"),
    providerStatusCode: readNullableInteger(row, "providerStatusCode"),
    providerDeliveredAt: readNullableText(row, "providerDeliveredAt"),
    preRedriveMutationCount: readInteger(row, "preRedriveMutationCount"),
    finalMutationCount: readNullableInteger(row, "finalMutationCount"),
    startedAt: readNullableText(row, "startedAt"),
    dispatchedAt: readNullableText(row, "dispatchedAt"),
    completedAt: readNullableText(row, "completedAt"),
    createdAt: readText(row, "createdAt"),
    updatedAt: readText(row, "updatedAt"),
  };
}

function mapReceipt(row: RecoveryReceiptRow): RecoveryReceipt {
  if (row.outcome !== "RECOVERY_COMPLETE") {
    throw new Error("Recovery receipt row has an invalid outcome.");
  }
  return {
    id: readText(row, "id"),
    incidentId: readText(row, "incidentId"),
    recoveryAttemptId: readText(row, "recoveryAttemptId"),
    deploymentId: readText(row, "deploymentId"),
    dispatchId: readText(row, "dispatchId"),
    originalProviderStatusCode: readInteger(row, "originalProviderStatusCode"),
    originalReceiverMutationCount: readInteger(row, "originalReceiverMutationCount"),
    patchSha256: readText(row, "patchSha256"),
    sandboxRetryStatusCode: readInteger(row, "sandboxRetryStatusCode"),
    sandboxRetryMutationCount: readInteger(row, "sandboxRetryMutationCount"),
    deploymentHealthStatusCode: readInteger(row, "deploymentHealthStatusCode"),
    preRedriveMutationCount: readInteger(row, "preRedriveMutationCount"),
    redeliveryProviderStatusCode: readInteger(row, "redeliveryProviderStatusCode"),
    finalReceiverMutationCount: readInteger(row, "finalReceiverMutationCount"),
    finalReceiverBusinessState: readText(row, "finalReceiverBusinessState"),
    outcome: "RECOVERY_COMPLETE",
    receiptJson: readText(row, "receiptJson"),
    createdAt: readText(row, "createdAt"),
  };
}

function isSuccessStatusCode(value: number | null): value is number {
  return (
    value !== null &&
    value >= REDRIVE_SUCCESS_MIN &&
    value <= REDRIVE_SUCCESS_MAX
  );
}

function validateBusinessState(
  value: BusinessStateReadResult,
): BusinessStateReadResult {
  if (
    value.mutationCount !== 1 ||
    value.businessState !== "EXACTLY_ONE"
  ) {
    throw new RedriveError(
      "PRECONDITION_FAILED",
      "The receiver business state is not exactly one mutation.",
    );
  }
  return value;
}

function parseBusinessStateResult(
  value: unknown,
  deliveryGuid: string,
): BusinessStateReadResult {
  try {
    return parseBusinessStateReadResult(value, deliveryGuid);
  } catch {
    throw new RedriveError(
      "RECEIVER_VERIFICATION_FAILED",
      "The receiver returned invalid business-state evidence.",
    );
  }
}

interface RecoveryCandidate {
  incident: Incident;
  applicationConnectionId: string;
  recoveryAttempt: RecoveryAttempt;
  deployment: RecoveryDeployment;
  fingerprintBase: Omit<RedriveFingerprintInput, "preRedriveMutationCount">;
}

function fingerprintFor(
  candidate: RecoveryCandidate,
  preRedriveMutationCount: 1,
): { input: RedriveFingerprintInput; hash: string } {
  const input: RedriveFingerprintInput = {
    ...candidate.fingerprintBase,
    preRedriveMutationCount,
  };
  return { input, hash: computeRedriveFingerprintSha256(input) };
}

function candidatePublicView(candidate: RecoveryCandidate) {
  return {
    recoveryAttemptId: candidate.recoveryAttempt.id,
    deploymentId: candidate.deployment.id,
    applicationConnectionId: candidate.applicationConnectionId,
    providerDeliveryId: candidate.fingerprintBase.providerDeliveryId,
    deliveryGuid: candidate.recoveryAttempt.deliveryGuid,
    patchSha256: candidate.recoveryAttempt.patchSha256,
    deploymentTarget: candidate.deployment.deploymentTarget,
  };
}

function sameCandidate(left: RecoveryCandidate, right: RecoveryCandidate): boolean {
  return (
    left.incident.id === right.incident.id &&
    left.applicationConnectionId === right.applicationConnectionId &&
    left.recoveryAttempt.id === right.recoveryAttempt.id &&
    left.deployment.id === right.deployment.id &&
    left.recoveryAttempt.deliveryGuid === right.recoveryAttempt.deliveryGuid &&
    left.recoveryAttempt.patchSha256 === right.recoveryAttempt.patchSha256 &&
    left.fingerprintBase.providerDeliveryId === right.fingerprintBase.providerDeliveryId
  );
}

export function parseRedrivePermitRequest(value: unknown): { fingerprint: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedriveRequestError("Redrive permit request must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.fingerprint !== "string" ||
    !HEX_64.test(record.fingerprint)
  ) {
    throw new RedriveRequestError(
      "Redrive permit request must contain exactly one 64-character fingerprint.",
    );
  }
  return { fingerprint: record.fingerprint };
}

export function parseRedriveExecuteRequest(value: unknown): { permitId: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new RedriveRequestError("Redrive request must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    typeof record.permitId !== "string" ||
    record.permitId.length === 0 ||
    record.permitId.length > 1024
  ) {
    throw new RedriveRequestError(
      "Redrive request must contain exactly one permitId.",
    );
  }
  return { permitId: record.permitId };
}

export function createRedriveService(options: RedriveServiceOptions) {
  const now = options.now ?? (() => new Date().toISOString());
  const polling = options.polling ?? {};
  const incidentService = createIncidentService(options.database);

  function getAttemptRows(incidentId: string): RecoveryAttemptRow[] {
    return options.database.all<RecoveryAttemptRow>(
      `SELECT ${recoveryAttemptColumns}
         FROM recovery_attempts
        WHERE incident_id = ? AND state = 'REPAIR_VERIFIED'
        ORDER BY id ASC`,
      [incidentId],
    );
  }

  function getDeploymentRows(
    incidentId: string,
    recoveryAttemptId: string,
  ): RecoveryDeploymentRow[] {
    return options.database.all<RecoveryDeploymentRow>(
      `SELECT ${recoveryDeploymentColumns}
         FROM recovery_deployments
        WHERE incident_id = ?
          AND recovery_attempt_id = ?
          AND state = 'VERIFIED'
        ORDER BY id ASC`,
      [incidentId, recoveryAttemptId],
    );
  }

  function loadCandidate(incidentId: string): RecoveryCandidate {
    const incident = incidentService.getById(incidentId);
    if (incident === null) {
      throw new RedriveError("NOT_FOUND", "Incident not found.");
    }
    if (incident.provider !== "github" || incident.applicationConnectionId === undefined) {
      throw new RedriveError(
        "INELIGIBLE",
        "The incident is not bound to a GitHub application connection.",
      );
    }
    const connection = getApplicationConnection(
      options.database,
      incident.applicationConnectionId,
    );
    if (connection === null) {
      throw new RedriveError(
        "INELIGIBLE",
        "The incident application connection is unavailable.",
      );
    }

    const attempts = getAttemptRows(incidentId).map(mapRecoveryAttempt);
    if (attempts.length !== 1) {
      throw new RedriveError(
        "INELIGIBLE",
        attempts.length === 0
          ? "A verified recovery attempt is required."
          : "Recovery attempt eligibility is ambiguous.",
      );
    }
    const recoveryAttempt = attempts[0];
    if (
      recoveryAttempt.providerStatusCode !== 500 ||
      recoveryAttempt.receiverPreCount !== 1 ||
      recoveryAttempt.verificationPreCount !== 1 ||
      !isSuccessStatusCode(recoveryAttempt.verificationHttpStatus) ||
      recoveryAttempt.verificationPostCount !== 1
    ) {
      throw new RedriveError(
        "INELIGIBLE",
        "The verified recovery attempt does not satisfy the redrive contract.",
      );
    }

    const deployments = getDeploymentRows(incidentId, recoveryAttempt.id).map(
      mapRecoveryDeployment,
    );
    if (deployments.length !== 1) {
      throw new RedriveError(
        "INELIGIBLE",
        deployments.length === 0
          ? "A verified deployment is required."
          : "Deployment eligibility is ambiguous.",
      );
    }
    const deployment = deployments[0];
    if (
      deployment.patchSha256 !== recoveryAttempt.patchSha256 ||
      deployment.deploymentTarget !== REDRIVE_DEPLOYMENT_TARGET ||
      deployment.preDeployMutationCount !== 1 ||
      deployment.postDeployMutationCount !== 1 ||
      deployment.healthStatusCode !== 200
    ) {
      throw new RedriveError(
        "INELIGIBLE",
        "The verified deployment does not satisfy the redrive contract.",
      );
    }

    return {
      incident,
      applicationConnectionId: connection.id,
      recoveryAttempt,
      deployment,
      fingerprintBase: {
        incidentId,
        recoveryAttemptId: recoveryAttempt.id,
        deploymentId: deployment.id,
        applicationConnectionId: connection.id,
        providerDeliveryId: incident.externalDeliveryId,
        deliveryGuid: recoveryAttempt.deliveryGuid,
        patchSha256: recoveryAttempt.patchSha256,
        deploymentTarget: REDRIVE_DEPLOYMENT_TARGET,
      },
    };
  }

  function getPermitById(id: string): RedrivePermit | null {
    const row = options.database.get<RedrivePermitRow>(
      `SELECT ${redrivePermitColumns} FROM redrive_permits WHERE id = ?`,
      [id],
    );
    return row === undefined ? null : mapPermit(row);
  }

  function getPermitByFingerprint(fingerprint: string): RedrivePermit | null {
    const row = options.database.get<RedrivePermitRow>(
      `SELECT ${redrivePermitColumns}
         FROM redrive_permits
        WHERE fingerprint_sha256 = ?`,
      [fingerprint],
    );
    return row === undefined ? null : mapPermit(row);
  }

  function getLatestPermit(incidentId: string): RedrivePermit | null {
    const row = options.database.get<RedrivePermitRow>(
      `SELECT ${redrivePermitColumns}
         FROM redrive_permits
        WHERE incident_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
      [incidentId],
    );
    return row === undefined ? null : mapPermit(row);
  }

  function getDispatchByPermitId(permitId: string): RedriveDispatch | null {
    const row = options.database.get<RedriveDispatchRow>(
      `SELECT ${redriveDispatchColumns}
         FROM redrive_dispatches
        WHERE redrive_permit_id = ?`,
      [permitId],
    );
    return row === undefined ? null : mapDispatch(row);
  }

  function getDispatchById(id: string): RedriveDispatch | null {
    const row = options.database.get<RedriveDispatchRow>(
      `SELECT ${redriveDispatchColumns} FROM redrive_dispatches WHERE id = ?`,
      [id],
    );
    return row === undefined ? null : mapDispatch(row);
  }

  function getReceiptByIncidentId(incidentId: string): RecoveryReceipt | null {
    const row = options.database.get<RecoveryReceiptRow>(
      `SELECT ${recoveryReceiptColumns}
         FROM recovery_receipts
        WHERE incident_id = ?`,
      [incidentId],
    );
    return row === undefined ? null : mapReceipt(row);
  }

  async function readFreshReceiverState(
    candidate: RecoveryCandidate,
  ): Promise<BusinessStateReadResult> {
    let result: BusinessStateReadResult;
    try {
      result = parseBusinessStateResult(
        await options.receiver.readBusinessState(
          candidate.applicationConnectionId,
          candidate.recoveryAttempt.deliveryGuid,
        ),
        candidate.recoveryAttempt.deliveryGuid,
      );
    } catch (error) {
      if (error instanceof RedriveError) throw error;
      throw new RedriveError(
        "PRECONDITION_FAILED",
        "The fresh receiver business-state read could not be established.",
      );
    }
    return validateBusinessState(result);
  }

  async function getState(incidentId: string) {
    const receipt = getReceiptByIncidentId(incidentId);
    let candidate: RecoveryCandidate;
    try {
      candidate = loadCandidate(incidentId);
    } catch (error) {
      if (error instanceof RedriveError && error.code === "NOT_FOUND") throw error;
      const permit = getLatestPermit(incidentId);
      return {
        eligibility: {
          eligible: false,
          reason: error instanceof Error ? error.message : "Recovery is ineligible.",
        },
        candidate: null,
        fingerprint: null,
        permit,
        dispatch: permit === null ? null : getDispatchByPermitId(permit.id),
        receipt,
      };
    }

    let fingerprint: string | null = null;
    let receiverState: BusinessStateReadResult | null = null;
    let eligibility: { eligible: boolean; reason?: string };
    try {
      receiverState = await readFreshReceiverState(candidate);
      fingerprint = fingerprintFor(candidate, 1).hash;
      eligibility = { eligible: true };
    } catch (error) {
      eligibility = {
        eligible: false,
        reason: error instanceof Error ? error.message : "Fresh receiver proof failed.",
      };
    }

    const permit = getLatestPermit(incidentId);
    return {
      eligibility,
      candidate: candidatePublicView(candidate),
      fingerprint,
      receiverState,
      permit,
      dispatch: permit === null ? null : getDispatchByPermitId(permit.id),
      receipt,
    };
  }

  async function approve(
    incidentId: string,
    submittedFingerprint: string,
  ): Promise<RedrivePermit> {
    if (!HEX_64.test(submittedFingerprint)) {
      throw new RedriveError("INVALID_INPUT", "The redrive fingerprint is invalid.");
    }

    const existingByFingerprint = getPermitByFingerprint(submittedFingerprint);
    if (existingByFingerprint !== null) {
      if (existingByFingerprint.incidentId !== incidentId) {
        throw new RedriveError(
          "PERMIT_CONFLICT",
          "The redrive fingerprint belongs to another incident.",
        );
      }
      if (existingByFingerprint.state === "REVOKED") {
        throw new RedriveError(
          "PERMIT_CONFLICT",
          "The redrive permit has been revoked.",
        );
      }
      return existingByFingerprint;
    }

    const existingForIncident = getLatestPermit(incidentId);
    if (existingForIncident !== null) {
      throw new RedriveError(
        "PERMIT_CONFLICT",
        "This incident already has a different redrive permit.",
      );
    }

    const candidate = loadCandidate(incidentId);
    const receiverState = await readFreshReceiverState(candidate);
    const { input, hash } = fingerprintFor(candidate, 1);
    if (hash !== submittedFingerprint) {
      throw new RedriveError(
        "FINGERPRINT_MISMATCH",
        "The submitted redrive fingerprint does not match current durable state.",
      );
    }

    const approvedAt = now();
    const id = randomUUID();
    return options.database.transaction(() => {
      const current = loadCandidate(incidentId);
      if (!sameCandidate(candidate, current)) {
        throw new RedriveError(
          "FINGERPRINT_MISMATCH",
          "Durable recovery state changed before permit approval.",
        );
      }
      const latest = getLatestPermit(incidentId);
      if (latest !== null) {
        if (latest.fingerprintSha256 === submittedFingerprint) return latest;
        throw new RedriveError(
          "PERMIT_CONFLICT",
          "This incident already has a different redrive permit.",
        );
      }
      options.database.run(
        `INSERT INTO redrive_permits (
           id, incident_id, recovery_attempt_id, deployment_id,
           fingerprint_sha256, patch_sha256, provider_delivery_id,
           delivery_guid, state, approved_at, consumed_at, created_at
         ) VALUES (
           @id, @incidentId, @recoveryAttemptId, @deploymentId,
           @fingerprintSha256, @patchSha256, @providerDeliveryId,
           @deliveryGuid, 'APPROVED', @approvedAt, NULL, @createdAt
         )`,
        {
          id,
          incidentId,
          recoveryAttemptId: input.recoveryAttemptId,
          deploymentId: input.deploymentId,
          fingerprintSha256: submittedFingerprint,
          patchSha256: input.patchSha256,
          providerDeliveryId: input.providerDeliveryId,
          deliveryGuid: input.deliveryGuid,
          approvedAt,
          createdAt: approvedAt,
        },
      );
      const permit = getPermitById(id);
      if (permit === null) throw new Error("Redrive permit was not persisted.");
      return permit;
    }, "immediate");
  }

  function executionResult(
    outcome: "DISPATCHING" | "OUTCOME_UNKNOWN" | "FAILED" | "DISPATCHED" | "PROVIDER_VERIFIED" | "COMPLETE",
    dispatch: RedriveDispatch,
    reason?: string,
    receipt?: RecoveryReceipt | null,
  ) {
    return { outcome, dispatch, ...(reason === undefined ? {} : { reason }), ...(receipt === undefined ? {} : { receipt }) };
  }

  function transitionDispatch(
    dispatchId: string,
    from: RedriveDispatchState,
    to: RedriveDispatchState,
    values: {
      updatedAt: string;
      providerStatusCode?: number | null;
      providerRedeliveryId?: string | null;
      providerDeliveredAt?: string | null;
      dispatchedAt?: string | null;
      finalMutationCount?: number | null;
      completedAt?: string | null;
    },
  ): RedriveDispatch {
    options.database.run(
      `UPDATE redrive_dispatches
          SET state = @to,
              provider_status_code = COALESCE(@providerStatusCode, provider_status_code),
              provider_redelivery_id = COALESCE(@providerRedeliveryId, provider_redelivery_id),
              provider_delivered_at = COALESCE(@providerDeliveredAt, provider_delivered_at),
              dispatched_at = COALESCE(@dispatchedAt, dispatched_at),
              final_mutation_count = COALESCE(@finalMutationCount, final_mutation_count),
              completed_at = COALESCE(@completedAt, completed_at),
              updated_at = @updatedAt
        WHERE id = @id AND state = @from`,
      {
        id: dispatchId,
        from,
        to,
        updatedAt: values.updatedAt,
        providerStatusCode: values.providerStatusCode ?? null,
        providerRedeliveryId: values.providerRedeliveryId ?? null,
        providerDeliveredAt: values.providerDeliveredAt ?? null,
        dispatchedAt: values.dispatchedAt ?? null,
        finalMutationCount: values.finalMutationCount ?? null,
        completedAt: values.completedAt ?? null,
      },
    );
    const updated = options.database.get<RedriveDispatchRow>(
      `SELECT ${redriveDispatchColumns} FROM redrive_dispatches WHERE id = ?`,
      [dispatchId],
    );
    if (updated === undefined) throw new Error("Redrive dispatch disappeared.");
    return mapDispatch(updated);
  }

  interface RedeliveryObservationSuccess {
    delivery: GithubWebhookDeliveryChoice;
  }

  interface RedeliveryObservationResult {
    success: RedeliveryObservationSuccess | null;
    reason: string | null;
    ambiguous: boolean;
  }

  async function observeRedelivery(
    dispatch: RedriveDispatch,
  ): Promise<RedeliveryObservationResult> {
    const maxAttempts = Math.max(1, Math.min(20, polling.maxAttempts ?? 5));
    const intervalMs = Math.max(0, Math.min(60_000, polling.intervalMs ?? 250));
    const sleep = polling.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
    const startedAt = dispatch.startedAt === null ? NaN : Date.parse(dispatch.startedAt);
    if (!Number.isFinite(startedAt)) {
      return { success: null, reason: "Dispatch start time is invalid.", ambiguous: true };
    }

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      let rawDeliveries: unknown[];
      try {
        rawDeliveries = await options.github.listWebhookDeliveryAttempts(
          dispatch.applicationConnectionId,
        );
      } catch {
        return {
          success: null,
          reason: "Provider delivery history could not be read.",
          ambiguous: false,
        };
      }

      let deliveries: GithubWebhookDeliveryChoice[];
      try {
        deliveries = rawDeliveries.map(parseGithubWebhookDelivery);
      } catch {
        return {
          success: null,
          reason: "Provider delivery history was invalid.",
          ambiguous: true,
        };
      }

      const matching = deliveries.filter((delivery) => {
        if (
          delivery.guid !== dispatch.deliveryGuid ||
          delivery.redelivery !== true ||
          delivery.deliveredAt === null
        ) {
          return false;
        }
        const deliveredAt = Date.parse(delivery.deliveredAt);
        return Number.isFinite(deliveredAt) && deliveredAt >= startedAt;
      });

      if (matching.length > 1) {
        return {
          success: null,
          reason: "Provider redelivery candidates are ambiguous.",
          ambiguous: true,
        };
      }
      if (matching.length === 1) {
        const delivery = matching[0];
        if (!isSuccessStatusCode(delivery.statusCode)) {
          return {
            success: null,
            reason: "The observed provider redelivery was not successful.",
            ambiguous: false,
          };
        }
        return { success: { delivery }, reason: null, ambiguous: false };
      }

      if (attempt + 1 < maxAttempts) await sleep(intervalMs);
    }

    return {
      success: null,
      reason: "No unambiguous successful provider redelivery was observed.",
      ambiguous: false,
    };
  }

  async function completeFromProviderVerified(
    candidate: RecoveryCandidate,
    dispatch: RedriveDispatch,
  ) {
    if (dispatch.providerRedeliveryId === null || dispatch.providerStatusCode === null) {
      throw new RedriveError(
        "PROVIDER_VERIFICATION_FAILED",
        "Provider verification is missing durable redelivery evidence.",
      );
    }
    let receiverState: BusinessStateReadResult;
    try {
      receiverState = parseBusinessStateResult(
        await options.receiver.readBusinessState(
          candidate.applicationConnectionId,
          candidate.recoveryAttempt.deliveryGuid,
        ),
        candidate.recoveryAttempt.deliveryGuid,
      );
    } catch (error) {
      return executionResult(
        "PROVIDER_VERIFIED",
        dispatch,
        error instanceof Error ? error.message : "Final receiver observation failed.",
      );
    }
    if (
      receiverState.mutationCount !== 1 ||
      receiverState.businessState !== "EXACTLY_ONE"
    ) {
      const failed = transitionDispatch(
        dispatch.id,
        "PROVIDER_VERIFIED",
        "FAILED",
        {
          updatedAt: now(),
          finalMutationCount: receiverState.mutationCount,
        },
      );
      return executionResult(
        "FAILED",
        failed,
        "The final receiver business state was not exactly one mutation.",
      );
    }

    const createdAt = now();
    const receiptJson = JSON.stringify({
      schemaVersion: 1,
      outcome: "RECOVERY_COMPLETE",
      incidentId: candidate.incident.id,
      original: {
        providerStatusCode: candidate.recoveryAttempt.providerStatusCode,
        receiverMutationCount: candidate.recoveryAttempt.receiverPreCount,
      },
      repair: {
        patchSha256: candidate.recoveryAttempt.patchSha256,
        sandboxRetryStatusCode: candidate.recoveryAttempt.verificationHttpStatus,
        sandboxRetryMutationCount: candidate.recoveryAttempt.verificationPostCount,
      },
      deployment: {
        deploymentId: candidate.deployment.id,
        healthStatusCode: candidate.deployment.healthStatusCode,
        preRedriveMutationCount: dispatch.preRedriveMutationCount,
      },
      redrive: {
        originalDeliveryId: dispatch.originalDeliveryId,
        redeliveryDeliveryId: dispatch.providerRedeliveryId,
        providerStatusCode: dispatch.providerStatusCode,
        finalReceiverMutationCount: receiverState.mutationCount,
        finalReceiverBusinessState: receiverState.businessState,
      },
    });
    if (receiptJson === undefined) throw new Error("Recovery receipt could not be serialized.");

    const completed = options.database.transaction(() => {
      const existing = getReceiptByIncidentId(candidate.incident.id);
      if (existing !== null) {
        const existingDispatch = getDispatchById(existing.dispatchId);
        if (existingDispatch === null) {
          throw new Error("Recovery receipt has no dispatch.");
        }
        return { receipt: existing, dispatch: existingDispatch };
      }
      const completion = options.database.run(
        `UPDATE redrive_dispatches
            SET state = 'COMPLETE',
                final_mutation_count = ?,
                completed_at = ?,
                updated_at = ?
          WHERE id = ? AND state = 'PROVIDER_VERIFIED'`,
        [receiverState.mutationCount, createdAt, createdAt, dispatch.id],
      );
      if (completion.changes !== 1) {
        const racedReceipt = getReceiptByIncidentId(candidate.incident.id);
        if (racedReceipt !== null) {
          const racedDispatch = getDispatchById(racedReceipt.dispatchId);
          if (racedDispatch === null) throw new Error("Recovery receipt has no dispatch.");
          return { receipt: racedReceipt, dispatch: racedDispatch };
        }
        throw new RedriveError(
          "RECEIVER_VERIFICATION_FAILED",
          "The dispatch was no longer provider-verified when final receiver evidence arrived.",
        );
      }
      options.database.run(
        `INSERT INTO recovery_receipts (
           id, incident_id, recovery_attempt_id, deployment_id, dispatch_id,
           original_provider_status_code, original_receiver_mutation_count,
           patch_sha256, sandbox_retry_status_code, sandbox_retry_mutation_count,
           deployment_health_status_code, pre_redrive_mutation_count,
           redelivery_provider_status_code, final_receiver_mutation_count,
           final_receiver_business_state, outcome, receipt_json, created_at
         ) VALUES (
           @id, @incidentId, @recoveryAttemptId, @deploymentId, @dispatchId,
           @originalProviderStatusCode, @originalReceiverMutationCount,
           @patchSha256, @sandboxRetryStatusCode, @sandboxRetryMutationCount,
           @deploymentHealthStatusCode, @preRedriveMutationCount,
           @redeliveryProviderStatusCode, @finalReceiverMutationCount,
           @finalReceiverBusinessState, 'RECOVERY_COMPLETE', @receiptJson, @createdAt
         )`,
        {
          id: randomUUID(),
          incidentId: candidate.incident.id,
          recoveryAttemptId: candidate.recoveryAttempt.id,
          deploymentId: candidate.deployment.id,
          dispatchId: dispatch.id,
          originalProviderStatusCode: candidate.recoveryAttempt.providerStatusCode,
          originalReceiverMutationCount: candidate.recoveryAttempt.receiverPreCount,
          patchSha256: candidate.recoveryAttempt.patchSha256,
          sandboxRetryStatusCode: candidate.recoveryAttempt.verificationHttpStatus,
          sandboxRetryMutationCount: candidate.recoveryAttempt.verificationPostCount,
          deploymentHealthStatusCode: candidate.deployment.healthStatusCode,
          preRedriveMutationCount: dispatch.preRedriveMutationCount,
          redeliveryProviderStatusCode: dispatch.providerStatusCode,
          finalReceiverMutationCount: receiverState.mutationCount,
          finalReceiverBusinessState: receiverState.businessState,
          receiptJson,
          createdAt,
        },
      );
      const persisted = getReceiptByIncidentId(candidate.incident.id);
      if (persisted === null) throw new Error("Recovery receipt was not persisted.");
      const completedDispatch = getDispatchById(dispatch.id);
      if (completedDispatch === null) throw new Error("Redrive dispatch disappeared.");
      return { receipt: persisted, dispatch: completedDispatch };
    }, "immediate");
    return executionResult("COMPLETE", completed.dispatch, undefined, completed.receipt);
  }

  async function continueDispatch(
    candidate: RecoveryCandidate,
    dispatch: RedriveDispatch,
  ) {
    if (dispatch.state === "COMPLETE") {
      return executionResult("COMPLETE", dispatch, undefined, getReceiptByIncidentId(candidate.incident.id));
    }
    if (dispatch.state === "FAILED") {
      return executionResult("FAILED", dispatch, "The dispatch is terminally failed.");
    }
    if (dispatch.state === "DISPATCHING") {
      return executionResult(
        "DISPATCHING",
        dispatch,
        "The provider write may have been accepted; manual reconciliation is required.",
      );
    }
    if (dispatch.state === "PREPARED") {
      return executionResult("FAILED", dispatch, "An unprepared dispatch cannot be redriven.");
    }

    if (dispatch.state === "DISPATCHED" || dispatch.state === "OUTCOME_UNKNOWN") {
      const observed = await observeRedelivery(dispatch);
      if (observed.success === null) {
        if (dispatch.state === "DISPATCHED" && (observed.ambiguous || observed.reason !== null)) {
          const failed = transitionDispatch(
            dispatch.id,
            "DISPATCHED",
            "FAILED",
            { updatedAt: now() },
          );
          return executionResult("FAILED", failed, observed.reason ?? "Provider verification failed.");
        }
        return executionResult(
          "OUTCOME_UNKNOWN",
          dispatch,
          observed.reason ?? "Provider verification remains unresolved.",
        );
      }

      const providerVerified = transitionDispatch(
        dispatch.id,
        dispatch.state,
        "PROVIDER_VERIFIED",
        {
          updatedAt: now(),
          providerRedeliveryId: observed.success.delivery.id,
          providerStatusCode: observed.success.delivery.statusCode,
          providerDeliveredAt: observed.success.delivery.deliveredAt,
        },
      );
      return completeFromProviderVerified(candidate, providerVerified);
    }

    if (dispatch.state === "PROVIDER_VERIFIED") {
      return completeFromProviderVerified(candidate, dispatch);
    }

    return executionResult("FAILED", dispatch, "The dispatch state is unsupported.");
  }

  async function execute(
    incidentId: string,
    permitId: string,
  ) {
    const existingReceipt = getReceiptByIncidentId(incidentId);
    if (existingReceipt !== null) {
      const dispatch = getDispatchById(existingReceipt.dispatchId);
      if (dispatch === null) throw new Error("Recovery receipt has no dispatch.");
      return executionResult("COMPLETE", dispatch, undefined, existingReceipt);
    }

    const permit = getPermitById(permitId);
    if (permit === null || permit.incidentId !== incidentId) {
      throw new RedriveError("PERMIT_NOT_FOUND", "The redrive permit was not found.");
    }
    const existingDispatch = getDispatchByPermitId(permit.id);
    if (existingDispatch !== null) {
      if (existingDispatch.state === "DISPATCHING") {
        return executionResult(
          "DISPATCHING",
          existingDispatch,
          "The provider write may have been accepted; manual reconciliation is required.",
        );
      }
      if (existingDispatch.state === "FAILED") {
        return executionResult("FAILED", existingDispatch, "The dispatch is terminally failed.");
      }
      const candidate = loadCandidate(incidentId);
      return continueDispatch(candidate, existingDispatch);
    }
    if (permit.state !== "APPROVED") {
      throw new RedriveError(
        "PERMIT_CONFLICT",
        "The redrive permit is not available for dispatch.",
      );
    }

    const candidate = loadCandidate(incidentId);
    const receiverState = await readFreshReceiverState(candidate);
    const { input, hash } = fingerprintFor(candidate, 1);
    if (hash !== permit.fingerprintSha256) {
      throw new RedriveError(
        "FINGERPRINT_MISMATCH",
        "The redrive permit is stale because durable recovery state changed.",
      );
    }

    const startedAt = now();
    const dispatchId = randomUUID();
    const dispatch = options.database.transaction(() => {
      const currentPermit = getPermitById(permit.id);
      if (currentPermit === null) throw new RedriveError("PERMIT_NOT_FOUND", "The redrive permit was not found.");
      const currentDispatch = getDispatchByPermitId(currentPermit.id);
      if (currentDispatch !== null) return currentDispatch;
      if (currentPermit.state !== "APPROVED") {
        throw new RedriveError("PERMIT_CONFLICT", "The redrive permit is not available for dispatch.");
      }
      const currentCandidate = loadCandidate(incidentId);
      if (!sameCandidate(candidate, currentCandidate)) {
        throw new RedriveError("FINGERPRINT_MISMATCH", "Durable recovery state changed before dispatch.");
      }
      options.database.run(
        `UPDATE redrive_permits
            SET state = 'CONSUMED', consumed_at = @consumedAt
          WHERE id = @id AND state = 'APPROVED'`,
        { id: currentPermit.id, consumedAt: startedAt },
      );
      options.database.run(
        `INSERT INTO redrive_dispatches (
           id, incident_id, redrive_permit_id, application_connection_id,
           original_delivery_id, delivery_guid, state, provider_redelivery_id,
           provider_status_code, provider_delivered_at, pre_redrive_mutation_count,
           final_mutation_count, started_at, dispatched_at, completed_at,
           created_at, updated_at
         ) VALUES (
           @id, @incidentId, @permitId, @applicationConnectionId,
           @originalDeliveryId, @deliveryGuid, 'DISPATCHING', NULL,
           NULL, NULL, @preRedriveMutationCount, NULL, @startedAt, NULL, NULL,
           @createdAt, @updatedAt
         )`,
        {
          id: dispatchId,
          incidentId,
          permitId: currentPermit.id,
          applicationConnectionId: input.applicationConnectionId,
          originalDeliveryId: input.providerDeliveryId,
          deliveryGuid: input.deliveryGuid,
          preRedriveMutationCount: receiverState.mutationCount,
          startedAt,
          createdAt: startedAt,
          updatedAt: startedAt,
        },
      );
      const persisted = getDispatchByPermitId(currentPermit.id);
      if (persisted === null) throw new Error("Redrive dispatch was not persisted.");
      return persisted;
    }, "immediate");

    if (dispatch.id !== dispatchId) return continueDispatch(candidate, dispatch);

    let acceptedStatusCode: number;
    try {
      acceptedStatusCode = await options.github.redeliverWebhookDelivery(
        input.applicationConnectionId,
        input.providerDeliveryId,
      );
    } catch (error) {
      if (error instanceof GithubRestError && error.code === "HTTP" && error.status !== null && error.status >= 400 && error.status < 500) {
        const failed = transitionDispatch(dispatch.id, "DISPATCHING", "FAILED", { updatedAt: now() });
        return executionResult("FAILED", failed, "GitHub rejected the redelivery before acceptance.");
      }
      if (error instanceof GithubRestError && error.code === "CONFIGURATION") throw error;
      const unknown = transitionDispatch(dispatch.id, "DISPATCHING", "OUTCOME_UNKNOWN", { updatedAt: now() });
      return executionResult("OUTCOME_UNKNOWN", unknown, "The GitHub redelivery outcome could not be proven.");
    }

    if (!isSuccessStatusCode(acceptedStatusCode)) {
      const failed = transitionDispatch(dispatch.id, "DISPATCHING", "FAILED", { updatedAt: now() });
      return executionResult("FAILED", failed, "GitHub did not accept the redelivery.");
    }
    const dispatched = transitionDispatch(dispatch.id, "DISPATCHING", "DISPATCHED", {
      updatedAt: now(),
      providerStatusCode: acceptedStatusCode,
      dispatchedAt: now(),
    });
    return continueDispatch(candidate, dispatched);
  }

  return {
    getState,
    approve,
    execute,
    getPermitById,
    getDispatchByPermitId,
    getReceiptByIncidentId,
    loadCandidate,
    serializeFingerprint: serializeRedriveFingerprint,
  };
}
