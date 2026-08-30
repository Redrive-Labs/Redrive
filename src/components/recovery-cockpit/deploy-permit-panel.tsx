"use client";

import { useState } from "react";
import { formatUtcTimestamp } from "./format-utc";
import { StatusLabel } from "./status-label";
import type { RecoveryAction, RecoveryCockpitViewModel } from "./types";

interface DeployPermitPanelProps {
  deployment?: RecoveryCockpitViewModel["deployment"];
  sandbox?: RecoveryCockpitViewModel["sandbox"];
  onApprove?: RecoveryAction;
}

type PermitState = "UNAVAILABLE" | "AWAITING HUMAN APPROVAL" | "APPROVED" | "DEPLOYMENT BLOCKED" | "OUTCOME UNKNOWN";

function approvalState(deployment: RecoveryCockpitViewModel["deployment"]): PermitState {
  if (!deployment || deployment.state === "NOT_READY") return "UNAVAILABLE";
  if (deployment.state === "FAILED") return "DEPLOYMENT BLOCKED";
  if (deployment.state === "OUTCOME_UNKNOWN") return "OUTCOME UNKNOWN";
  if (["APPROVED", "DEPLOYING", "VERIFIED"].includes(deployment.state)) return "APPROVED";
  return "AWAITING HUMAN APPROVAL";
}

function labelFor(state: PermitState): string {
  if (state === "APPROVED") return "VERIFIED";
  if (state === "AWAITING HUMAN APPROVAL") return "WAITING_APPROVAL";
  if (state === "DEPLOYMENT BLOCKED") return "DEPLOYMENT BLOCKED";
  if (state === "OUTCOME UNKNOWN") return "OUTCOME_UNKNOWN";
  return "LOCKED";
}

export function DeployPermitPanel({ deployment, sandbox, onApprove }: DeployPermitPanelProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const state = approvalState(deployment);
  const patchSha256 = deployment?.patchSha256 ?? sandbox?.patchSha256;
  const eligible = sandbox?.state === "REPAIR_VERIFIED" && patchSha256 !== undefined && deployment?.state === "AWAITING_APPROVAL";
  const approved = state === "APPROVED";
  const expanded = state === "AWAITING HUMAN APPROVAL" || state === "DEPLOYMENT BLOCKED" || state === "OUTCOME UNKNOWN";

  async function handleApprove() {
    if (!onApprove || !eligible || isApproving) return;
    setError(null);
    setIsApproving(true);
    try { await onApprove(); }
    catch { setError("DeployPermit approval was not recorded."); }
    finally { setIsApproving(false); }
  }

  return (
    <section className={`permit-panel${expanded ? " permit-panel--expanded" : " permit-panel--compact"}`} aria-labelledby="deploy-permit-title">
      <div className="permit-panel__header">
        <div>
          <p className="mono-type permit-panel__kicker">Human control</p>
          <h4 id="deploy-permit-title">Deploy Permit</h4>
        </div>
        <StatusLabel compact status={isApproving ? "ACTIVE" : labelFor(state)} />
      </div>

      {state === "AWAITING HUMAN APPROVAL" ? <>
        <div className="permit-facts">
          <div><span>Candidate</span><strong className="mono-type" title={patchSha256}>{patchSha256}</strong></div>
          <div><span>Target</span><strong className="mono-type">{deployment?.deploymentTarget ?? "Not available"}</strong></div>
          <div><span>Fingerprint</span><strong className="mono-type" title={deployment?.fingerprint}>{deployment?.fingerprint ?? "Not available"}</strong></div>
        </div>
        <p className="permit-panel__copy">Authorize deployment of this exact candidate to this target.</p>
        <p className="permit-panel__state">{isApproving ? "Approving immutable permit…" : "Awaiting human approval"}</p>
      </> : null}

      {deployment?.failure ? <div className="permit-feedback permit-feedback--failure" role="alert">
        <strong>Deployment blocked</strong>
        <p>Receiver verification changed.</p>
        <dl>
          <div><dt>Expected mutation count</dt><dd>{deployment.failure.expectedMutationCount}</dd></div>
          <div><dt>Observed mutation count</dt><dd>{deployment.failure.observedMutationCount}</dd></div>
        </dl>
        <p>No deployment was attempted.</p>
      </div> : null}

      {state === "UNAVAILABLE" ? <p className="permit-panel__reason">Repair verification has not completed.</p> : null}
      {approved ? <p className="permit-feedback permit-feedback--approved">Approved by operator{deployment?.approvedAt ? ` · ${formatUtcTimestamp(deployment.approvedAt)}` : ""}</p> : null}
      {state === "OUTCOME UNKNOWN" ? <div className="permit-feedback permit-feedback--failure"><strong>Outcome unknown</strong><p>Deployment outcome is unresolved.</p><p>Manual reconciliation required.</p></div> : null}
      {state === "DEPLOYMENT BLOCKED" && !deployment?.failure ? <p className="permit-panel__reason">No deployment was attempted.</p> : null}
      {error ? <p className="permit-feedback permit-feedback--failure" role="alert">{error}</p> : null}

      {state === "AWAITING HUMAN APPROVAL" || state === "UNAVAILABLE" ? <button className="permit-action" disabled={!onApprove || !eligible || isApproving || approved} onClick={() => void handleApprove()} type="button">
        {isApproving ? "Approving…" : "Review & approve deployment"}
      </button> : null}
    </section>
  );
}
