"use client";

import { useState } from "react";
import { formatUtcTimestamp } from "./format-utc";
import { StatusLabel } from "./status-label";
import type { RecoveryAction, RecoveryCockpitViewModel } from "./types";

interface RedrivePermitPanelProps {
  incident: RecoveryCockpitViewModel["incident"];
  receiver?: RecoveryCockpitViewModel["receiver"];
  deployment?: RecoveryCockpitViewModel["deployment"];
  redrive?: RecoveryCockpitViewModel["redrive"];
  sandbox?: RecoveryCockpitViewModel["sandbox"];
  onApprove?: RecoveryAction;
}

type RedriveState = NonNullable<RecoveryCockpitViewModel["redrive"]>["state"];
const isApproved = (state: RedriveState | undefined) => ["APPROVED", "DISPATCHING", "VERIFYING", "COMPLETE"].includes(state ?? "");

export function RedrivePermitPanel({ incident, receiver, deployment, redrive, sandbox, onApprove }: RedrivePermitPanelProps) {
  const [isApproving, setIsApproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patchSha256 = redrive && sandbox?.patchSha256;
  const receiverObserved = receiver?.observed === true;
  const eligible = deployment?.state === "VERIFIED" && redrive?.state === "AWAITING_APPROVAL" && receiverObserved && receiver.businessState === "EXACTLY_ONE" && receiver.mutationCount === 1;
  const approved = isApproved(redrive?.state);
  const waiting = redrive?.state === "AWAITING_APPROVAL";
  const expanded = waiting || redrive?.state === "OUTCOME_UNKNOWN" || redrive?.state === "BLOCKED";
  const label = approved ? "VERIFIED" : waiting ? "WAITING_APPROVAL" : redrive?.state === "OUTCOME_UNKNOWN" ? "OUTCOME_UNKNOWN" : redrive?.state === "BLOCKED" ? "FAILED" : "LOCKED";

  async function handleApprove() {
    if (!onApprove || !eligible || isApproving) return;
    setError(null);
    setIsApproving(true);
    try { await onApprove(); }
    catch { setError("RedrivePermit approval was not recorded."); }
    finally { setIsApproving(false); }
  }

  return (
    <section className={`permit-panel${expanded ? " permit-panel--expanded" : " permit-panel--compact"}`} aria-labelledby="redrive-permit-title">
      <div className="permit-panel__header">
        <div>
          <p className="mono-type permit-panel__kicker">Human control</p>
          <h4 id="redrive-permit-title">Redrive Permit</h4>
        </div>
        <StatusLabel compact status={isApproving ? "ACTIVE" : label} />
      </div>

      {waiting ? <>
        <div className="permit-facts permit-facts--redrive">
          <div><span>Original delivery</span><strong className="mono-type" title={incident.deliveryId}>{incident.deliveryId}</strong></div>
          <div><span>Delivery GUID</span><strong className="mono-type" title={incident.deliveryGuid}>{incident.deliveryGuid ?? "Not available"}</strong></div>
          <div><span>Patch digest</span><strong className="mono-type" title={patchSha256}>{patchSha256 ?? "Not available"}</strong></div>
          <div><span>Verified deployment</span><strong className="mono-type">{deployment?.deploymentTarget ?? "Not verified"}</strong></div>
          <div><span>Receiver count</span><strong className="mono-type">{receiverObserved ? receiver.mutationCount : "Not observed"}</strong></div>
          <div><span>Fingerprint</span><strong className="mono-type" title={redrive?.fingerprint}>{redrive?.fingerprint ?? "Not available"}</strong></div>
        </div>
        <p className="permit-panel__copy">Authorize exactly one GitHub redelivery of the original delivery.</p>
        <p className="permit-panel__state">{isApproving ? "Approving immutable permit…" : "Awaiting human approval"}</p>
      </> : null}

      {approved ? <p className="permit-feedback permit-feedback--approved">Approved by operator{redrive?.approvedAt ? ` · ${formatUtcTimestamp(redrive.approvedAt)}` : ""}</p> : null}
      {redrive?.state === "OUTCOME_UNKNOWN" ? <div className="permit-feedback permit-feedback--failure"><strong>Outcome unknown</strong><p>Redrive cannot prove whether GitHub accepted the request.</p><p>Automatic retry disabled. Manual reconciliation required.</p></div> : null}
      {redrive?.state === "BLOCKED" ? <p className="permit-feedback permit-feedback--failure">Redrive is blocked. No redelivery was attempted.</p> : null}
      {waiting && !eligible ? <p className="permit-panel__reason">Deployment must be independently verified before redrive approval.</p> : null}
      {!redrive || redrive.state === "NOT_READY" ? <p className="permit-panel__reason">Deployment must be independently verified before redrive approval.</p> : null}
      {error ? <p className="permit-feedback permit-feedback--failure" role="alert">{error}</p> : null}

      {waiting || !redrive || redrive.state === "NOT_READY" ? <button className="permit-action" disabled={!onApprove || !eligible || isApproving || approved} onClick={() => void handleApprove()} type="button">
        {isApproving ? "Approving…" : "Approve exactly one GitHub redelivery"}
      </button> : null}
    </section>
  );
}
