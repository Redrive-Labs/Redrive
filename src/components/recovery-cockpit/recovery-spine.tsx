import type { ReactNode } from "react";
import { formatUtcTimestamp } from "./format-utc";
import { RecoveryStage, type RecoveryStageModel } from "./recovery-stage";
import type { RecoveryCockpitViewModel, SpineStatus } from "./types";

interface RecoverySpineProps {
  viewModel: RecoveryCockpitViewModel;
  deployPermit?: ReactNode;
  redrivePermit?: ReactNode;
  startAction?: ReactNode;
  deployAction?: ReactNode;
  redriveAction?: ReactNode;
}

function proofChain(proof: { preCount: number; httpStatus: number; postCount: number }) {
  return (
    <span className="proof-chain">
      <span>{proof.preCount}</span>
      <span className="proof-chain__arrow" aria-hidden="true">→</span>
      <span className="proof-chain__status">HTTP {proof.httpStatus}</span>
      <span className="proof-chain__arrow" aria-hidden="true">→</span>
      <span>{proof.postCount}</span>
    </span>
  );
}

function repairCandidateDisclosure(
  sandbox: RecoveryCockpitViewModel["sandbox"],
): ReactNode {
  if (!sandbox?.patchSha256 && !sandbox?.originalRevision && !sandbox?.changedFiles?.length) {
    return null;
  }

  return (
    <details className="candidate-details">
      <summary>View candidate →</summary>
      <dl className="evidence-details__list">
        {sandbox.originalRevision ? (
          <div className="evidence-details__row">
            <dt>Failing revision</dt>
            <dd className="mono-type" title={sandbox.originalRevision}>{sandbox.originalRevision}</dd>
          </div>
        ) : null}
        {sandbox.patchSha256 ? (
          <div className="evidence-details__row">
            <dt>Patch SHA256</dt>
            <dd className="mono-type" title={sandbox.patchSha256}>{sandbox.patchSha256}</dd>
          </div>
        ) : null}
        {sandbox.changedFiles?.length ? (
          <div className="evidence-details__row">
            <dt>Changed files</dt>
            <dd className="mono-type">{sandbox.changedFiles.join(" · ")}</dd>
          </div>
        ) : null}
      </dl>
    </details>
  );
}

function statusForInvestigation(viewModel: RecoveryCockpitViewModel): SpineStatus {
  return viewModel.provider?.observed && viewModel.receiver?.observed
    ? "VERIFIED"
    : "PENDING";
}

function statusForReproduction(
  sandbox: RecoveryCockpitViewModel["sandbox"],
): SpineStatus {
  if (!sandbox || sandbox.state === "NOT_STARTED") return "LOCKED";
  if (sandbox.state === "RUNNING") return "ACTIVE";
  if (sandbox.state === "FAILED") return "FAILED";
  if (sandbox.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  return sandbox.reproduction ? "VERIFIED" : "ACTIVE";
}

function statusForRepair(
  sandbox: RecoveryCockpitViewModel["sandbox"],
): SpineStatus {
  if (!sandbox || sandbox.state === "NOT_STARTED") return "LOCKED";
  if (sandbox.state === "RUNNING") return "ACTIVE";
  if (sandbox.state === "FAILED") return "FAILED";
  if (sandbox.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  return sandbox.state === "REPAIR_VERIFIED" && sandbox.verification && sandbox.patchSha256
    ? "VERIFIED"
    : "PENDING";
}

function statusForDeployApproval(
  deployment: RecoveryCockpitViewModel["deployment"],
  sandbox: RecoveryCockpitViewModel["sandbox"],
): SpineStatus {
  if (!deployment || deployment.state === "NOT_READY") return "LOCKED";
  if (deployment.state === "AWAITING_APPROVAL") return "WAITING_APPROVAL";
  if (deployment.state === "APPROVED" || deployment.state === "DEPLOYING" || deployment.state === "VERIFIED") return "VERIFIED";
  if (deployment.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (deployment.state === "FAILED") return "FAILED";
  return sandbox?.state === "REPAIR_VERIFIED" ? "PENDING" : "LOCKED";
}

function statusForDeployment(
  deployment: RecoveryCockpitViewModel["deployment"],
): SpineStatus {
  if (!deployment || deployment.state === "NOT_READY" || deployment.state === "AWAITING_APPROVAL") return "LOCKED";
  if (deployment.state === "APPROVED" || deployment.state === "DEPLOYING") return "ACTIVE";
  if (deployment.state === "VERIFIED") return "VERIFIED";
  if (deployment.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  return "FAILED";
}

function statusForRedriveApproval(
  redrive: RecoveryCockpitViewModel["redrive"],
  deployment: RecoveryCockpitViewModel["deployment"],
): SpineStatus {
  if (!redrive || redrive.state === "NOT_READY") return "LOCKED";
  if (redrive.state === "AWAITING_APPROVAL") return "WAITING_APPROVAL";
  if (redrive.state === "APPROVED" || redrive.state === "DISPATCHING" || redrive.state === "VERIFYING" || redrive.state === "COMPLETE") return "VERIFIED";
  if (redrive.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (redrive.state === "BLOCKED") return "FAILED";
  return deployment?.state === "VERIFIED" ? "PENDING" : "LOCKED";
}

function statusForRedelivery(
  redrive: RecoveryCockpitViewModel["redrive"],
): SpineStatus {
  if (!redrive || redrive.state === "NOT_READY" || redrive.state === "AWAITING_APPROVAL") return "LOCKED";
  if (redrive.state === "APPROVED" || redrive.state === "DISPATCHING" || redrive.state === "VERIFYING") return "ACTIVE";
  if (redrive.state === "COMPLETE") return "VERIFIED";
  if (redrive.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (redrive.state === "BLOCKED") return "FAILED";
  return "FAILED";
}

function statusForFinalVerification(
  redrive: RecoveryCockpitViewModel["redrive"],
  receipt: RecoveryCockpitViewModel["receipt"],
): SpineStatus {
  if (receipt?.outcome === "RECOVERY_COMPLETE" && redrive?.state === "COMPLETE") return "COMPLETE";
  if (redrive?.state === "VERIFYING") return "ACTIVE";
  if (redrive?.state === "OUTCOME_UNKNOWN") return "OUTCOME_UNKNOWN";
  if (redrive?.state === "BLOCKED") return "FAILED";
  if (redrive?.state === "COMPLETE") return "VERIFIED";
  return "LOCKED";
}

function stagesFor(
  viewModel: RecoveryCockpitViewModel,
): RecoveryStageModel[] {
  const { provider, receiver, sandbox, deployment, redrive, receipt } = viewModel;
  const repairVerified = sandbox?.state === "REPAIR_VERIFIED" && Boolean(sandbox.patchSha256);
  const deploymentVerified = deployment?.state === "VERIFIED";
  const investigationStatus = statusForInvestigation(viewModel);
  const reproductionStatus = statusForReproduction(sandbox);
  const repairStatus = statusForRepair(sandbox);

  return [
    {
      number: "01",
      title: "Investigated",
      status: investigationStatus,
      detail: provider?.observed && receiver?.observed
        ? "Provider Investigator · Receiver Investigator"
        : "Awaiting independent provider and receiver evidence.",
    },
    {
      number: "02",
      title: "Reproduced",
      status: reproductionStatus,
      detail: sandbox?.reproduction ? "Daytona sandbox · reconstructed sandbox request" : undefined,
      proof: sandbox?.reproduction ? proofChain(sandbox.reproduction) : undefined,
      reason: reproductionStatus === "LOCKED"
        ? "Sandbox recovery has not started."
        : sandbox?.state === "FAILED"
          ? sandbox.failureReason ?? "Sandbox recovery failed."
          : sandbox?.state === "OUTCOME_UNKNOWN"
            ? "Sandbox session outcome is unresolved. Automatic recovery is disabled."
            : undefined,
    },
    {
      number: "03",
      title: "Repair verified",
      status: repairStatus,
      detail: sandbox?.verification ? "Verified retry · mutation count held" : undefined,
      proof: sandbox?.verification ? (
        <>
          {proofChain(sandbox.verification)}
          {sandbox.patchSha256 ? <p className="stage-artifact"><span>Patch</span> <span className="mono-type" title={sandbox.patchSha256}>{sandbox.patchSha256}</span></p> : null}
          {repairCandidateDisclosure(sandbox)}
        </>
      ) : undefined,
      reason: repairStatus === "LOCKED" ? "A reproduced failure is required before repair verification." : undefined,
    },
    {
      number: "04",
      title: "Deploy approval",
      status: statusForDeployApproval(deployment, sandbox),
      detail: deployment?.approvedAt ? `DeployPermit approved · ${formatUtcTimestamp(deployment.approvedAt)}` : undefined,
      reason: !repairVerified ? "Repair verification has not completed." : undefined,
    },
    {
      number: "05",
      title: "Deployment",
      status: statusForDeployment(deployment),
      detail: deployment?.state === "VERIFIED" ? `Healthy · HTTP ${deployment.healthStatusCode ?? "2xx"}` : undefined,
      reason: deployment?.failure
        ? "No deployment was attempted."
        : deployment?.reason,
    },
    {
      number: "06",
      title: "Redrive approval",
      status: statusForRedriveApproval(redrive, deployment),
      detail: redrive?.approvedAt ? `RedrivePermit approved · ${formatUtcTimestamp(redrive.approvedAt)}` : undefined,
      reason: !deploymentVerified ? "Deployment must be independently verified." : undefined,
    },
    {
      number: "07",
      title: "GitHub redelivery",
      status: statusForRedelivery(redrive),
      detail: redrive?.providerStatusCode ? `GitHub response · HTTP ${redrive.providerStatusCode}` : undefined,
      reason: redrive?.state === "OUTCOME_UNKNOWN"
        ? "Redrive cannot prove whether GitHub accepted the redelivery request."
        : redrive?.reason,
    },
    {
      number: "08",
      title: "Final verification",
      status: statusForFinalVerification(redrive, receipt),
      detail: redrive?.finalMutationCount !== undefined
        ? `Receiver ${redrive.finalMutationCount === 1 ? "EXACTLY_ONE" : "MUTATION_COUNT_CHANGED"} · mutation count ${redrive.finalMutationCount}`
        : undefined,
      reason: redrive?.state === "OUTCOME_UNKNOWN" ? "Automatic retry disabled. Manual reconciliation required." : undefined,
    },
  ];
}

export function RecoverySpine({
  viewModel,
  deployPermit,
  redrivePermit,
  startAction,
  deployAction,
  redriveAction,
}: RecoverySpineProps) {
  const stages = stagesFor(viewModel);

  return (
    <section className="recovery-record" aria-labelledby="recovery-record-title">
      <div className="recovery-record__header">
        <div>
          <p className="mono-type section-kicker">Recovery record</p>
          <h2 id="recovery-record-title">Evidence before action.</h2>
        </div>
        <p className="recovery-record__note">Eight stages · one authoritative spine</p>
      </div>
      <ol className="recovery-spine">
        {stages.map((stage) => {
          const showPermit = stage.status !== "LOCKED" && stage.status !== "PENDING";
          return (
            <RecoveryStage
              isLast={stage.number === "08"}
              key={stage.number}
              stage={stage}
            >
              {stage.number === "02" && startAction
                ? startAction
                : showPermit && stage.number === "04"
                  ? deployPermit
                  : stage.number === "05" && deployAction
                    ? deployAction
                    : showPermit && stage.number === "06"
                      ? redrivePermit
                      : stage.number === "07" && redriveAction
                        ? redriveAction
                        : null}
            </RecoveryStage>
          );
        })}
      </ol>
    </section>
  );
}
