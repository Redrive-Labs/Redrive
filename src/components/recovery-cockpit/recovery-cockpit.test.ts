import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DeployPermitPanel } from "./deploy-permit-panel";
import { RedrivePermitPanel } from "./redrive-permit-panel";
import { RecoveryCockpit } from "./recovery-cockpit";
import type { RecoveryCockpitViewModel } from "./types";

const incident: RecoveryCockpitViewModel["incident"] = {
  id: "incident-fixture",
  repository: "example/receiver",
  deliveryId: "delivery-fixture-001",
  deliveryGuid: "guid-fixture-001",
  event: "GitHub push",
  createdAt: "2026-08-27T21:02:57.000Z",
  status: "PENDING",
};

const receiver: NonNullable<RecoveryCockpitViewModel["receiver"]> = {
  mutationCount: 1,
  businessState: "EXACTLY_ONE",
  observed: true,
  observedAt: "2026-08-27T21:03:01.000Z",
  provenance: {
    trueForgeSessionId: "session-fixture",
    turnId: "turn-fixture",
    investigator: "Receiver Investigator",
    toolName: "get_business_state",
    deliveryGuid: "guid-fixture-001",
  },
};

const provider: NonNullable<RecoveryCockpitViewModel["provider"]> = {
  statusCode: 500,
  status: "Delivery failed",
  observed: true,
  observedAt: "2026-08-27T21:03:00.000Z",
  provenance: {
    trueForgeSessionId: "session-fixture",
    turnId: "turn-fixture",
    investigator: "Provider Investigator",
    toolName: "get_delivery",
  },
};

function model(
  overrides: Partial<RecoveryCockpitViewModel> = {},
): RecoveryCockpitViewModel {
  return {
    incident,
    provider,
    receiver,
    assessment: {
      contradiction: "PROVIDER_FAILED_RECEIVER_MUTATED",
      recoveryState: "BLOCKED",
    },
    ...overrides,
  };
}

describe("RecoveryCockpit presentation states", () => {
  it("renders the provider/receiver contradiction and Retry unsafe", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, { viewModel: model() }),
    );

    expect(html).toContain("HTTP 500");
    expect(html).toContain("EXACTLY_ONE");
    expect(html).toContain("Mutation count: 1");
    expect(html).toContain("Retry unsafe");
    expect(html).toContain("GitHub reports failure, but the receiver already mutated once.");
    expect(html).toContain("Recovery blocked");
    expect(html).toContain("PROVIDER_FAILED_RECEIVER_MUTATED");
    expect(html).toContain("Run isolated sandbox recovery");
    expect(html).not.toContain("Investigate failure");
  });

  it("hands an investigated contradiction to the existing sandbox recovery action", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({ sandbox: { state: "NOT_STARTED" } }),
      }),
    );

    expect(html).toContain("Start sandbox recovery");
    expect(html).not.toContain("Investigate failure");
  });

  it("renders pending evidence without manufacturing permit surfaces", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: {
          incident,
          provider: { statusCode: 0, status: "Pending", observed: false },
          receiver: { mutationCount: 0, businessState: "EXACTLY_ONE", observed: false },
          assessment: { contradiction: null, recoveryState: "BLOCKED" },
        },
      }),
    );

    expect(html).toContain("Provider observation has not been supplied.");
    expect(html).toContain("Receiver observation has not been supplied.");
    expect(html).not.toContain("Retry unsafe");
    expect(html).not.toContain("Deploy Permit");
    expect(html).not.toContain("Redrive Permit");
    expect(html).toContain("Investigate failure");
  });

  it("formats the dossier timestamp in deterministic UTC", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, { viewModel: model() }),
    );

    expect(html).toContain("Aug 27, 21:02:57 UTC");
    expect(html).not.toContain("suppressHydrationWarning");
  });

  it("does not manufacture the contradiction when receiver state is absent", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({
          receiver: {
            mutationCount: 0,
            businessState: "ABSENT",
            observed: true,
          },
          assessment: { contradiction: null, recoveryState: "BLOCKED" },
        }),
      }),
    );

    expect(html).not.toContain("Retry unsafe");
    expect(html).not.toContain("work already happened");
    expect(html).toContain("Receiver mutation state is absent.");
  });

  it("treats authoritative non-contradictory evidence as complete and unavailable for recovery", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({
          provider: { ...provider, statusCode: 404, status: "Delivery unavailable" },
          receiver: { ...receiver, mutationCount: 0, businessState: "ABSENT" },
          assessment: { contradiction: null, recoveryState: "BLOCKED" },
          sandbox: { state: "NOT_STARTED" },
        }),
      }),
    );

    expect(html).toContain("Authoritative investigation complete");
    expect(html).toContain("No replay-safety contradiction was established.");
    expect(html).not.toContain("Investigate failure");
    expect(html).not.toContain("Start sandbox recovery");
  });

  it("renders Daytona reproduction and verified retry proof for a repaired candidate", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({
          sandbox: {
            state: "REPAIR_VERIFIED",
            originalRevision: "revision-fixture",
            reproduction: { preCount: 0, httpStatus: 500, postCount: 1 },
            verification: { preCount: 1, httpStatus: 204, postCount: 1 },
            patchSha256: "sha256:patch-fixture",
            changedFiles: ["src/webhook.ts"],
          },
          deployment: {
            state: "AWAITING_APPROVAL",
            patchSha256: "sha256:patch-fixture",
            deploymentTarget: "receiver-fixture",
            fingerprint: "fingerprint-fixture",
          },
        }),
      }),
    );

    expect(html).toContain("Daytona sandbox");
    expect(html).toContain("HTTP 500");
    expect(html).toContain("HTTP 204");
    expect(html).toContain("sha256:patch-fixture");
    expect(html).toContain("revision-fixture");
    expect(html).toContain("View candidate →");
    expect(html).toContain("src/webhook.ts");
    expect(html).toContain("Review &amp; approve deployment");
  });

  it("does not display repair proof while the sandbox is pending", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({ sandbox: { state: "NOT_STARTED" } }),
      }),
    );

    expect(html).not.toContain("Daytona sandbox");
    expect(html).not.toContain("sha256:patch-fixture");
    expect(html).not.toContain("HTTP 204");
    expect(html).toContain("Sandbox recovery has not started.");
  });

  it("disables DeployPermit before repair eligibility", () => {
    const html = renderToStaticMarkup(
      createElement(DeployPermitPanel, {
        deployment: { state: "NOT_READY" },
        sandbox: { state: "NOT_STARTED" },
        onApprove: async () => undefined,
      }),
    );

    expect(html).toContain("Repair verification has not completed.");
    expect(html).toContain("disabled=\"\"");
  });

  it("disables RedrivePermit before deployment verification", () => {
    const html = renderToStaticMarkup(
      createElement(RedrivePermitPanel, {
        deployment: { state: "AWAITING_APPROVAL" },
        incident,
        onApprove: async () => undefined,
        receiver,
        redrive: { state: "AWAITING_APPROVAL" },
        sandbox: { state: "REPAIR_VERIFIED", patchSha256: "sha256:patch-fixture" },
      }),
    );

    expect(html).toContain("Deployment must be independently verified");
    expect(html).toContain("disabled=\"\"");
  });

  it("makes an unknown redelivery outcome explicit", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({ redrive: { state: "OUTCOME_UNKNOWN" } }),
      }),
    );

    expect(html).toContain("OUTCOME UNKNOWN");
    expect(html).toContain("Automatic retry disabled.");
    expect(html).toContain("Manual reconciliation required.");
  });

  it("renders the exact final receipt only for a complete outcome", () => {
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({
          redrive: {
            state: "COMPLETE",
            providerStatusCode: 200,
            finalMutationCount: 1,
          },
          receipt: {
            outcome: "RECOVERY_COMPLETE",
            originalProviderStatusCode: 500,
            originalReceiverMutationCount: 1,
            sandboxRetryStatusCode: 204,
            sandboxRetryMutationCount: 1,
            deploymentHealthStatusCode: 200,
            redeliveryProviderStatusCode: 200,
            finalReceiverMutationCount: 1,
            finalReceiverBusinessState: "EXACTLY_ONE",
          },
        }),
      }),
    );

    expect(html).toContain("Retried once. Mutated once.");
    expect(html).toContain("Recovery complete");
    expect(html).toContain("HTTP 204");
    expect(html).toContain("EXACTLY_ONE");
  });

  it("keeps long delivery IDs and digests in the rendered evidence", () => {
    const longId = "delivery-" + "x".repeat(180);
    const longDigest = "sha256:" + "a".repeat(128);
    const html = renderToStaticMarkup(
      createElement(RecoveryCockpit, {
        viewModel: model({
          incident: { ...incident, deliveryId: longId },
          sandbox: {
            state: "REPAIR_VERIFIED",
            patchSha256: longDigest,
            verification: { preCount: 1, httpStatus: 204, postCount: 1 },
          },
          deployment: {
            state: "AWAITING_APPROVAL",
            patchSha256: longDigest,
            fingerprint: longDigest,
          },
        }),
      }),
    );

    expect(html).toContain(longId);
    expect(html).toContain(longDigest);
    expect(html).toContain("dossier-header__delivery");
  });

  it("does not embed a canonical demo delivery ID in production rendering", () => {
    const pageSource = readFileSync(new URL("../../app/page.tsx", import.meta.url), "utf8");

    expect(pageSource).not.toContain("3839409944195514368");
  });
});
