import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeRedriveFingerprintSha256,
  REDRIVE_DEPLOYMENT_TARGET,
} from "@/domain/redrive";
import { GithubRestError } from "@/server/github/github-rest";
import { openDatabase, type SqliteDatabase } from "@/server/infrastructure/database";
import { createRedriveService } from "@/server/recovery/redrive-service";
import type { ReceiverBusinessStateReader } from "@/server/receiver/receiver-final-observation";
import type { RedriveGithubService } from "@/server/recovery/redrive-service";

const INCIDENT_ID = "incident-1";
const CONNECTION_ID = "connection-1";
const ATTEMPT_ID = "attempt-1";
const DEPLOY_PERMIT_ID = "deploy-permit-1";
const DEPLOYMENT_ID = "deployment-1";
const DELIVERY_ID = "original-delivery-1";
const DELIVERY_GUID = "delivery-guid-1";
const PATCH_SHA256 = "patch-sha256-1";
const STARTED_AT = "2026-01-01T00:00:01.000Z";
const DELIVERED_AT = "2026-01-01T00:00:02.000Z";

function businessState(
  mutationCount = 1,
  businessStateValue: "ABSENT" | "EXACTLY_ONE" | "MULTIPLE" = "EXACTLY_ONE",
) {
  return {
    schemaVersion: 1 as const,
    deliveryGuid: DELIVERY_GUID,
    mutationCount,
    businessState: businessStateValue,
    observedAt: DELIVERED_AT,
  };
}

describe("redrive service", () => {
  let directory: string;
  let database: SqliteDatabase;

  beforeEach(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), "redrive-c-test-"));
    database = openDatabase(path.join(directory, "records.sqlite"));
    database.run(
      `INSERT INTO github_app_registrations
       (id, github_app_id, slug, owner_id, owner_login, owner_type, private_key_ref, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["app-1", "app-id-1", "redrive", "owner-1", "octocat", "User", "key-1", STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO github_installations
       (installation_id, app_registration_id, account_id, account_login, account_type, repository_selection, last_verified_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ["installation-1", "app-1", "account-1", "octocat", "User", "selected", STARTED_AT, STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO application_connections
       (id, provider, github_installation_id, repository_id, repository_full_name, webhook_id, webhook_target_display, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [CONNECTION_ID, "github", "installation-1", "repo-1", "octocat/receiver", "hook-1", "https://receiver.example/webhook", "READY", STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO incidents
       (id, provider, external_delivery_id, repository_id, application_connection_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [INCIDENT_ID, "github", DELIVERY_ID, "repo-1", CONNECTION_ID, "OPEN", STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO recovery_attempts
       (id, incident_id, state, recovery_spec_version,
        source_repository_full_name, original_revision, provider_status_code,
        receiver_pre_count, delivery_guid, patch_text, patch_sha256,
        verification_pre_count, verification_http_status,
        verification_post_count, created_at, updated_at, verified_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [ATTEMPT_ID, INCIDENT_ID, "REPAIR_VERIFIED", "redrive.recovery.v1",
        "octocat/receiver", "5bfadf93d5233e4e6cfe0fdb19ad1b78328a5d79", 500,
        1, DELIVERY_GUID, "verified patch", PATCH_SHA256, 1, 201, 1,
        STARTED_AT, STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO deploy_permits
       (id, incident_id, recovery_attempt_id, fingerprint_sha256, patch_sha256,
        deployment_target, state, approved_at, consumed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'CONSUMED', ?, ?, ?)`,
      [DEPLOY_PERMIT_ID, INCIDENT_ID, ATTEMPT_ID, "d".repeat(64), PATCH_SHA256,
        REDRIVE_DEPLOYMENT_TARGET, STARTED_AT, STARTED_AT, STARTED_AT],
    );
    database.run(
      `INSERT INTO recovery_deployments
       (id, incident_id, recovery_attempt_id, deploy_permit_id, patch_sha256,
        deployment_target, state, pre_deploy_mutation_count,
        post_deploy_mutation_count, health_status_code, started_at,
        completed_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [DEPLOYMENT_ID, INCIDENT_ID, ATTEMPT_ID, DEPLOY_PERMIT_ID, PATCH_SHA256,
        REDRIVE_DEPLOYMENT_TARGET, "VERIFIED", 1, 1, 200, STARTED_AT,
        STARTED_AT, STARTED_AT, STARTED_AT],
    );
  });

  afterEach(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function makeService(options: {
    receiver?: ReceiverBusinessStateReader;
    github?: RedriveGithubService;
    now?: () => string;
  } = {}) {
    return createRedriveService({
      database,
      receiver: options.receiver ?? {
        readBusinessState: vi.fn(async () => businessState()),
      },
      github: options.github ?? {
        redeliverWebhookDelivery: vi.fn(async () => 202),
        listWebhookDeliveryAttempts: vi.fn(async () => [
          {
            id: "redelivery-1",
            guid: DELIVERY_GUID,
            redelivery: true,
            status: "OK",
            status_code: 200,
            delivered_at: DELIVERED_AT,
          },
        ]),
      },
      now: options.now ?? (() => STARTED_AT),
      polling: { maxAttempts: 2, intervalMs: 0, sleep: vi.fn(async () => undefined) },
    });
  }

  function fingerprint(): string {
    return computeRedriveFingerprintSha256({
      schemaVersion: 1,
      kind: "REDRIVE",
      incidentId: INCIDENT_ID,
      recoveryAttemptId: ATTEMPT_ID,
      deploymentId: DEPLOYMENT_ID,
      applicationConnectionId: CONNECTION_ID,
      providerDeliveryId: DELIVERY_ID,
      deliveryGuid: DELIVERY_GUID,
      patchSha256: PATCH_SHA256,
      deploymentTarget: REDRIVE_DEPLOYMENT_TARGET,
      preRedriveMutationCount: 1,
    });
  }

  it("uses the fixed-order deterministic fingerprint", () => {
    const fingerprintJson = JSON.stringify({
      schemaVersion: 1,
      kind: "REDRIVE",
      incidentId: INCIDENT_ID,
      recoveryAttemptId: ATTEMPT_ID,
      deploymentId: DEPLOYMENT_ID,
      applicationConnectionId: CONNECTION_ID,
      providerDeliveryId: DELIVERY_ID,
      deliveryGuid: DELIVERY_GUID,
      patchSha256: PATCH_SHA256,
      deploymentTarget: REDRIVE_DEPLOYMENT_TARGET,
      preRedriveMutationCount: 1,
    });
    expect(fingerprintJson).toBe(
      '{"schemaVersion":1,"kind":"REDRIVE","incidentId":"incident-1","recoveryAttemptId":"attempt-1","deploymentId":"deployment-1","applicationConnectionId":"connection-1","providerDeliveryId":"original-delivery-1","deliveryGuid":"delivery-guid-1","patchSha256":"patch-sha256-1","deploymentTarget":"demo-receiver-local","preRedriveMutationCount":1}',
    );
    expect(fingerprint()).toMatch(/^[a-f0-9]{64}$/);
  });

  it("requires verified A/B state and exact fresh receiver proof", async () => {
    database.run("UPDATE recovery_attempts SET verification_post_count = 2");
    const service = makeService();
    await expect(service.approve(INCIDENT_ID, fingerprint())).rejects.toMatchObject({
      code: "INELIGIBLE",
    });

    database.run("UPDATE recovery_attempts SET verification_post_count = 1");
    database.run("UPDATE recovery_deployments SET patch_sha256 = 'different-patch'");
    await expect(makeService().approve(INCIDENT_ID, fingerprint())).rejects.toMatchObject({
      code: "INELIGIBLE",
    });
    database.run("UPDATE recovery_deployments SET patch_sha256 = ?", [PATCH_SHA256]);
    const receiver = { readBusinessState: vi.fn(async () => businessState(2, "MULTIPLE")) };
    await expect(makeService({ receiver }).approve(INCIDENT_ID, fingerprint())).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
  });

  it("rejects a wrong fingerprint and makes exact approval replay idempotent", async () => {
    const receiver = { readBusinessState: vi.fn(async () => businessState()) };
    const service = makeService({ receiver });
    await expect(service.approve(INCIDENT_ID, "0".repeat(64))).rejects.toMatchObject({
      code: "FINGERPRINT_MISMATCH",
    });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const replay = await service.approve(INCIDENT_ID, fingerprint());
    expect(replay).toEqual(permit);
    expect(receiver.readBusinessState).toHaveBeenCalledTimes(2);
    expect(permit).toMatchObject({
      patchSha256: PATCH_SHA256,
      providerDeliveryId: DELIVERY_ID,
      deliveryGuid: DELIVERY_GUID,
      deploymentId: DEPLOYMENT_ID,
    });
  });

  it("consumes the permit and persists DISPATCHING before the single GitHub POST", async () => {
    const receiver = {
      readBusinessState: vi.fn()
        .mockResolvedValueOnce(businessState())
        .mockResolvedValueOnce(businessState())
        .mockResolvedValueOnce(businessState()),
    };
    let github: RedriveGithubService;
    let permit: Awaited<ReturnType<ReturnType<typeof createRedriveService>["approve"]>>;
    github = {
      redeliverWebhookDelivery: vi.fn(async () => {
        expect(database.get<{ state: string }>("SELECT state FROM redrive_permits WHERE id = ?", [permit.id])?.state).toBe("CONSUMED");
        expect(database.get<{ state: string }>("SELECT state FROM redrive_dispatches WHERE redrive_permit_id = ?", [permit.id])?.state).toBe("DISPATCHING");
        return 202;
      }),
      listWebhookDeliveryAttempts: vi.fn(async () => [
        { id: "redelivery-1", guid: DELIVERY_GUID, redelivery: true, status: "OK", status_code: 200, delivered_at: DELIVERED_AT },
      ]),
    };
    const service = makeService({ receiver, github });
    permit = await service.approve(INCIDENT_ID, fingerprint());
    const result = await service.execute(INCIDENT_ID, permit.id);

    expect(result.outcome).toBe("COMPLETE");
    expect(github.redeliverWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(database.get<{ state: string }>("SELECT state FROM redrive_dispatches WHERE redrive_permit_id = ?", [permit.id])?.state).toBe("COMPLETE");
    expect(database.get<{ count: number }>("SELECT COUNT(*) AS count FROM recovery_receipts WHERE incident_id = ?", [INCIDENT_ID])?.count).toBe(1);
  });

  it("turns a timeout into OUTCOME_UNKNOWN and never posts again", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => {
        throw new GithubRestError("TIMEOUT", "timeout");
      }),
      listWebhookDeliveryAttempts: vi.fn(async () => []),
    };
    const service = makeService({ github });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const first = await service.execute(INCIDENT_ID, permit.id);
    const second = await service.execute(INCIDENT_ID, permit.id);

    expect(first.outcome).toBe("OUTCOME_UNKNOWN");
    expect(second.outcome).toBe("OUTCOME_UNKNOWN");
    expect(github.redeliverWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(github.listWebhookDeliveryAttempts).toHaveBeenCalledTimes(2);
  });

  it("rejects continuation when the candidate changes after dispatch creation", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => {
        throw new GithubRestError("TIMEOUT", "timeout");
      }),
      listWebhookDeliveryAttempts: vi.fn(async () => []),
    };
    const service = makeService({ github });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const first = await service.execute(INCIDENT_ID, permit.id);
    expect(first.outcome).toBe("OUTCOME_UNKNOWN");

    database.run(
      "UPDATE recovery_attempts SET delivery_guid = ? WHERE id = ?",
      ["changed-delivery-guid", ATTEMPT_ID],
    );

    await expect(service.execute(INCIDENT_ID, permit.id)).rejects.toMatchObject({
      code: "FINGERPRINT_MISMATCH",
    });
    expect(github.listWebhookDeliveryAttempts).not.toHaveBeenCalled();
    expect(service.getReceiptByIncidentId(INCIDENT_ID)).toBeNull();
  });

  it("does not issue a second POST when durable state is already DISPATCHING", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => 202),
      listWebhookDeliveryAttempts: vi.fn(async () => []),
    };
    const receiver = { readBusinessState: vi.fn(async () => businessState()) };
    const service = makeService({ github, receiver });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    database.run("UPDATE redrive_permits SET state = 'CONSUMED', consumed_at = ? WHERE id = ?", [STARTED_AT, permit.id]);
    database.run(
      `INSERT INTO redrive_dispatches
       (id, incident_id, redrive_permit_id, application_connection_id, original_delivery_id,
        delivery_guid, state, provider_redelivery_id, provider_status_code, provider_delivered_at,
        pre_redrive_mutation_count, final_mutation_count, started_at, dispatched_at, completed_at,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'DISPATCHING', NULL, NULL, NULL, 1, NULL, ?, NULL, NULL, ?, ?)`,
      ["dispatch-crashed", INCIDENT_ID, permit.id, CONNECTION_ID, DELIVERY_ID, DELIVERY_GUID, STARTED_AT, STARTED_AT, STARTED_AT],
    );

    const result = await service.execute(INCIDENT_ID, permit.id);
    expect(result.outcome).toBe("DISPATCHING");
    expect(github.redeliverWebhookDelivery).not.toHaveBeenCalled();
  });

  it("blocks a provider redelivery that is not 2xx", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => 202),
      listWebhookDeliveryAttempts: vi.fn(async () => [
        { id: "redelivery-1", guid: DELIVERY_GUID, redelivery: true, status: "Failed", status_code: 500, delivered_at: DELIVERED_AT },
      ]),
    };
    const service = makeService({ github });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const result = await service.execute(INCIDENT_ID, permit.id);
    expect(result.outcome).toBe("FAILED");
    expect(service.getReceiptByIncidentId(INCIDENT_ID)).toBeNull();
  });

  it.each([0, 2])("blocks final receiver mutation count %s", async (mutationCount) => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => 202),
      listWebhookDeliveryAttempts: vi.fn(async () => [
        { id: "redelivery-1", guid: DELIVERY_GUID, redelivery: true, status: "OK", status_code: 200, delivered_at: DELIVERED_AT },
      ]),
    };
    const receiver = {
      readBusinessState: vi.fn()
        .mockResolvedValueOnce(businessState())
        .mockResolvedValueOnce(businessState())
        .mockResolvedValueOnce(businessState(mutationCount, mutationCount === 0 ? "ABSENT" : "MULTIPLE")),
    };
    const service = makeService({ github, receiver });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const result = await service.execute(INCIDENT_ID, permit.id);
    expect(result.outcome).toBe("FAILED");
    expect(service.getReceiptByIncidentId(INCIDENT_ID)).toBeNull();
  });

  it("fails closed for ambiguous provider candidates and non-exact final receiver state", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => 202),
      listWebhookDeliveryAttempts: vi.fn(async () => [
        { id: "redelivery-1", guid: DELIVERY_GUID, redelivery: true, status: "OK", status_code: 200, delivered_at: DELIVERED_AT },
        { id: "redelivery-2", guid: DELIVERY_GUID, redelivery: true, status: "OK", status_code: 200, delivered_at: DELIVERED_AT },
      ]),
    };
    const service = makeService({ github });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const result = await service.execute(INCIDENT_ID, permit.id);
    expect(result.outcome).toBe("FAILED");
    expect(service.getReceiptByIncidentId(INCIDENT_ID)).toBeNull();

    const secondDatabase = database;
    expect(secondDatabase.get<{ state: string }>("SELECT state FROM redrive_dispatches WHERE redrive_permit_id = ?", [permit.id])?.state).toBe("FAILED");
  });

  it("returns an existing receipt without another GitHub write", async () => {
    const github = {
      redeliverWebhookDelivery: vi.fn(async () => 202),
      listWebhookDeliveryAttempts: vi.fn(async () => [
        { id: "redelivery-1", guid: DELIVERY_GUID, redelivery: true, status: "OK", status_code: 200, delivered_at: DELIVERED_AT },
      ]),
    };
    const service = makeService({ github });
    const permit = await service.approve(INCIDENT_ID, fingerprint());
    const first = await service.execute(INCIDENT_ID, permit.id);
    const second = await service.execute(INCIDENT_ID, permit.id);
    expect(second.receipt).toEqual(first.receipt);
    expect(github.redeliverWebhookDelivery).toHaveBeenCalledTimes(1);
    expect(first.receipt).toMatchObject({
      incidentId: INCIDENT_ID,
      dispatchId: expect.any(String),
      recoveryAttemptId: ATTEMPT_ID,
      deploymentId: DEPLOYMENT_ID,
      patchSha256: PATCH_SHA256,
      redeliveryProviderStatusCode: 200,
      finalReceiverMutationCount: 1,
      finalReceiverBusinessState: "EXACTLY_ONE",
    });
    expect(JSON.parse(first.receipt?.receiptJson ?? "{}" as string)).toMatchObject({
      outcome: "RECOVERY_COMPLETE",
      incidentId: INCIDENT_ID,
      repair: { patchSha256: PATCH_SHA256 },
      redrive: {
        originalDeliveryId: DELIVERY_ID,
        redeliveryDeliveryId: "redelivery-1",
      },
    });
  });
});
