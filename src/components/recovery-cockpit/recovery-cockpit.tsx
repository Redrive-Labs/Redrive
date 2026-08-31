"use client";

import { useState } from "react";
import { ContradictionPanel } from "./contradiction-panel";
import { DeployPermitPanel } from "./deploy-permit-panel";
import { ExecutionProvenance } from "./execution-provenance";
import { IncidentDossierHeader } from "./incident-dossier-header";
import { RedrivePermitPanel } from "./redrive-permit-panel";
import { RecoveryReceipt } from "./recovery-receipt";
import { RecoverySpine } from "./recovery-spine";
import { investigateIncident } from "../incident-investigation-client";
import type { RecoveryAction, RecoveryCockpitViewModel } from "./types";

export interface RecoveryCockpitProps {
  viewModel: RecoveryCockpitViewModel;
  onStartRecovery?: RecoveryAction;
  onApproveDeployment?: RecoveryAction;
  onDeploy?: RecoveryAction;
  onApproveRedrive?: RecoveryAction;
  onRedrive?: RecoveryAction;
}

function currentStatus(viewModel: RecoveryCockpitViewModel): string {
  if (viewModel.receipt?.outcome === "RECOVERY_COMPLETE") return "RECOVERY COMPLETE";

  switch (viewModel.redrive?.state) {
    case "BLOCKED":
      return "RETRY BLOCKED";
    case "OUTCOME_UNKNOWN":
      return "OUTCOME UNKNOWN";
    case "VERIFYING":
    case "DISPATCHING":
      return "VERIFYING REDELIVERY";
    case "AWAITING_APPROVAL":
      return "AWAITING REDRIVE APPROVAL";
    case "COMPLETE":
      return "RECOVERY COMPLETE";
    default:
      break;
  }

  switch (viewModel.deployment?.state) {
    case "OUTCOME_UNKNOWN":
      return "OUTCOME UNKNOWN";
    case "FAILED":
      return "DEPLOYMENT BLOCKED";
    case "VERIFIED":
      return "DEPLOYMENT VERIFIED";
    case "AWAITING_APPROVAL":
      return "AWAITING DEPLOY APPROVAL";
    default:
      break;
  }

  if (viewModel.sandbox?.state === "OUTCOME_UNKNOWN") return "OUTCOME UNKNOWN";
  if (viewModel.sandbox?.state === "REPAIR_VERIFIED") return "REPAIR VERIFIED";
  const hasEstablishedContradiction =
    viewModel.assessment?.contradiction === "PROVIDER_FAILED_RECEIVER_MUTATED" &&
    viewModel.provider?.observed === true &&
    viewModel.provider.statusCode === 500 &&
    viewModel.receiver?.observed === true &&
    viewModel.receiver.mutationCount === 1 &&
    viewModel.receiver.businessState === "EXACTLY_ONE";
  if (hasEstablishedContradiction) {
    return "RETRY BLOCKED";
  }
  return "INVESTIGATION PENDING";
}

function ActiveProofPanel({ viewModel }: { viewModel: RecoveryCockpitViewModel }) {
  const providerCode = viewModel.provider?.observed ? viewModel.provider.statusCode : undefined;
  const mutationCount = viewModel.receiver?.observed ? viewModel.receiver.mutationCount : undefined;
  let title = "Recovery blocked";
  let summary = "The provider failed, but independent receiver evidence shows the mutation already occurred.";
  let nextAction = "Run isolated sandbox recovery";
  let facts = [
    ["Provider result", providerCode !== undefined ? `HTTP ${providerCode}` : "Pending"],
    ["Receiver mutation count", mutationCount !== undefined ? String(mutationCount) : "Pending"],
    ["Deterministic contradiction", viewModel.assessment?.contradiction ?? "Not established"],
  ];

  if (viewModel.receipt) {
    title = "Recovery complete";
    summary = "The original delivery was retried once and the receiver mutation remained exactly one.";
    nextAction = "No further action required";
    facts = [
      ["Original provider", `HTTP ${viewModel.receipt.originalProviderStatusCode}`],
      ["Sandbox retry", `HTTP ${viewModel.receipt.sandboxRetryStatusCode}`],
      ["Final receiver state", viewModel.receipt.finalReceiverBusinessState],
    ];
  } else if (viewModel.redrive && viewModel.redrive.state !== "NOT_READY") {
    title = viewModel.redrive.state === "COMPLETE" ? "Redelivery verified" : "Redelivery proof";
    summary = "GitHub redelivery remains constrained by the approved permit and independent final verification.";
    nextAction = viewModel.redrive.state === "APPROVED" ? "Execute one approved GitHub redelivery" : "Verify final receiver state";
    facts = [
      ["Redrive state", viewModel.redrive.state],
      ["Provider response", viewModel.redrive.providerStatusCode ? `HTTP ${viewModel.redrive.providerStatusCode}` : "Pending"],
      ["Final mutation count", viewModel.redrive.finalMutationCount !== undefined ? String(viewModel.redrive.finalMutationCount) : "Pending"],
    ];
  } else if (viewModel.deployment && viewModel.deployment.state !== "NOT_READY") {
    title = "Deployment proof";
    summary = "The verified repair remains bound to its candidate fingerprint and human deployment permit.";
    nextAction = viewModel.deployment.state === "APPROVED" ? "Execute approved deployment" : "Complete deployment verification";
    facts = [
      ["Deployment state", viewModel.deployment.state],
      ["Health response", viewModel.deployment.healthStatusCode ? `HTTP ${viewModel.deployment.healthStatusCode}` : "Pending"],
      ["Patch digest", viewModel.deployment.patchSha256 ?? "Pending"],
    ];
  } else if (viewModel.sandbox && viewModel.sandbox.state !== "NOT_STARTED") {
    title = viewModel.sandbox.state === "REPAIR_VERIFIED" ? "Repair verified" : "Sandbox recovery";
    summary = "The candidate is isolated in Daytona until replay safety and mutation invariants are proven.";
    nextAction = viewModel.sandbox.state === "REPAIR_VERIFIED" ? "Request deployment approval" : "Complete adversarial replay verification";
    facts = [
      ["Sandbox state", viewModel.sandbox.state],
      ["Original revision", viewModel.sandbox.originalRevision ?? "Pending"],
      ["Patch digest", viewModel.sandbox.patchSha256 ?? "Pending"],
    ];
  }

  return (
    <section className="active-proof-panel" aria-labelledby="active-proof-title">
      <div className="active-proof-panel__heading">
        <div>
          <p className="section-kicker">Active stage proof</p>
          <h2 id="active-proof-title">{title}</h2>
        </div>
        <span className="active-proof-panel__state">Evidence before action</span>
      </div>
      <p className="active-proof-panel__summary">{summary}</p>
      <dl className="active-proof-panel__facts">
        {facts.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd className="mono-type">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="active-proof-panel__next">
        <span>Next safe action</span>
        <strong>{nextAction}</strong>
      </div>
      <ul className="active-proof-panel__provenance" aria-label="Proof provenance">
        <li>TrueForge Coordinator</li>
        <li>Provider Investigator</li>
        <li>Receiver Investigator</li>
        <li>GitHub MCP</li>
        <li>Receiver MCP</li>
      </ul>
    </section>
  );
}

export function RecoveryCockpit({
  viewModel,
  onStartRecovery,
  onApproveDeployment,
  onDeploy,
  onApproveRedrive,
  onRedrive,
}: RecoveryCockpitProps) {
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [investigationPending, setInvestigationPending] = useState(false);
  const [investigationError, setInvestigationError] = useState<string | null>(null);
  const basePath = `/api/incidents/${encodeURIComponent(viewModel.incident.id)}/recovery`;

  async function post(path: string, body?: Record<string, string>) {
    setPendingAction(path);
    setActionError(null);
    try {
      const response = await fetch(`${basePath}/${path}`, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      if (!response.ok) throw new Error(payload?.error ?? `Recovery action failed with HTTP ${response.status}.`);
      window.location.reload();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Recovery action failed.");
      throw error;
    } finally {
      setPendingAction(null);
    }
  }

  async function investigateProvider(): Promise<void> {
    setInvestigationPending(true);
    setInvestigationError(null);
    try {
      await investigateIncident(viewModel.incident.id, fetch, () => window.location.reload());
    } catch (reason) {
      setInvestigationError(reason instanceof Error ? reason.message : "Provider investigation failed. Try again.");
    } finally {
      setInvestigationPending(false);
    }
  }

  const startRecovery = onStartRecovery ?? (() => post("sandbox"));
  const approveDeployment = onApproveDeployment ?? (() => {
    if (!viewModel.deployment?.fingerprint) throw new Error("Deployment fingerprint is unavailable.");
    return post("deploy-permit", { fingerprint: viewModel.deployment.fingerprint });
  });
  const deploy = onDeploy ?? (() => {
    if (!viewModel.deployment?.permitId) throw new Error("DeployPermit is unavailable.");
    return post("deploy", { permitId: viewModel.deployment.permitId });
  });
  const approveRedrive = onApproveRedrive ?? (() => {
    if (!viewModel.redrive?.fingerprint) throw new Error("Redrive fingerprint is unavailable.");
    return post("redrive-permit", { fingerprint: viewModel.redrive.fingerprint });
  });
  const redrive = onRedrive ?? (() => {
    if (!viewModel.redrive?.permitId) throw new Error("RedrivePermit is unavailable.");
    return post("redrive", { permitId: viewModel.redrive.permitId });
  });

  const contradictionEstablished =
    viewModel.assessment?.contradiction === "PROVIDER_FAILED_RECEIVER_MUTATED" &&
    viewModel.provider?.observed === true &&
    viewModel.provider.statusCode === 500 &&
    viewModel.receiver?.observed === true &&
    viewModel.receiver.mutationCount === 1 &&
    viewModel.receiver.businessState === "EXACTLY_ONE";
  const investigationComplete =
    viewModel.provider?.observed === true &&
    viewModel.receiver?.observed === true;
  const investigationRequired = !investigationComplete;
  const canStart = contradictionEstablished && viewModel.sandbox?.state === "NOT_STARTED";
  const canDeploy = viewModel.deployment?.state === "APPROVED";
  const canRedrive = viewModel.redrive?.state === "APPROVED";

  return (
    <article className="recovery-cockpit" id="incident-cockpit" aria-label="Recovery cockpit">
      <IncidentDossierHeader incident={viewModel.incident} status={currentStatus(viewModel)} />
      {investigationRequired ? (
        <section className="investigation-action" aria-labelledby="investigation-action-title">
          <div>
            <p className="section-kicker">Authoritative investigation</p>
            <h2 id="investigation-action-title">Provider and receiver evidence required.</h2>
            <p>Run the persisted incident through TrueForge to establish whether the failed delivery already mutated receiver state.</p>
          </div>
          <button className="stage-action" disabled={investigationPending} onClick={() => void investigateProvider()} type="button">
            {investigationPending ? "Investigating through TrueForge…" : "Investigate failure"}
          </button>
          {investigationError ? <p className="recovery-action-error" role="alert">{investigationError}</p> : null}
        </section>
      ) : null}
      {investigationComplete && !contradictionEstablished ? (
        <section className="investigation-action" aria-labelledby="investigation-complete-title">
          <div>
            <p className="section-kicker">Authoritative investigation complete</p>
            <h2 id="investigation-complete-title">No replay-safety contradiction was established.</h2>
            <p>Persisted provider and receiver evidence is available below. Recovery remains unavailable unless the deterministic assessment permits it.</p>
          </div>
        </section>
      ) : null}
      <ContradictionPanel assessment={viewModel.assessment} provider={viewModel.provider} receiver={viewModel.receiver} />
      <ActiveProofPanel viewModel={viewModel} />
      {actionError ? <p className="recovery-action-error" role="alert">{actionError}</p> : null}
      <RecoverySpine
        startAction={canStart ? (
          <button className="stage-action" disabled={pendingAction !== null} onClick={() => void startRecovery().catch(() => undefined)} type="button">
            {pendingAction === "sandbox" ? "Starting sandbox recovery…" : "Start sandbox recovery"}
          </button>
        ) : undefined}
        deployAction={canDeploy ? (
          <button className="stage-action" disabled={pendingAction !== null} onClick={() => void deploy().catch(() => undefined)} type="button">
            {pendingAction === "deploy" ? "Executing deployment…" : "Execute approved deployment"}
          </button>
        ) : undefined}
        redriveAction={canRedrive ? (
          <button className="stage-action stage-action--danger" disabled={pendingAction !== null} onClick={() => void redrive().catch(() => undefined)} type="button">
            {pendingAction === "redrive" ? "Executing one redelivery…" : "Execute one GitHub redelivery"}
          </button>
        ) : undefined}
        deployPermit={<DeployPermitPanel deployment={viewModel.deployment} onApprove={approveDeployment} sandbox={viewModel.sandbox} />}
        redrivePermit={<RedrivePermitPanel deployment={viewModel.deployment} incident={viewModel.incident} onApprove={approveRedrive} receiver={viewModel.receiver} redrive={viewModel.redrive} sandbox={viewModel.sandbox} />}
        viewModel={viewModel}
      />
      <p className="sr-only" aria-live="polite">{pendingAction ? "Recovery action in progress." : ""}</p>
      <RecoveryReceipt receipt={viewModel.receipt} />
      <ExecutionProvenance viewModel={viewModel} />
    </article>
  );
}

export type {
  DeploymentFailure,
  EvidenceProvenance,
  ReceiverBusinessState,
  RecoveryAction,
  RecoveryContradiction,
  RecoveryCockpitViewModel,
  SandboxProof,
  SandboxProvenance,
  SpineStatus,
} from "./types";
