import type { ReactNode } from "react";
import { StatusLabel } from "./status-label";
import type { SpineStatus } from "./types";

export interface RecoveryStageModel {
  number: string;
  title: string;
  status: SpineStatus;
  detail?: string;
  proof?: ReactNode;
  reason?: string;
}

interface RecoveryStageProps {
  stage: RecoveryStageModel;
  children?: ReactNode;
  isLast: boolean;
}

export function RecoveryStage({ stage, children, isLast }: RecoveryStageProps) {
  return (
    <li
      className={`recovery-stage recovery-stage--${stage.status.toLowerCase()}${isLast ? " recovery-stage--last" : ""}`}
    >
      <div className="recovery-stage__marker" aria-hidden="true">
        <span>{stage.status === "VERIFIED" || stage.status === "COMPLETE" ? "✓" : ""}</span>
      </div>
      <div className="recovery-stage__content">
        <div className="recovery-stage__heading">
          <div className="recovery-stage__name">
            <span className="mono-type recovery-stage__number">{stage.number}</span>
            <h3>{stage.title}</h3>
          </div>
          <StatusLabel compact status={stage.status} />
        </div>
        {stage.detail ? <p className="recovery-stage__detail">{stage.detail}</p> : null}
        {stage.proof ? <div className="recovery-stage__proof">{stage.proof}</div> : null}
        {stage.reason ? <p className="recovery-stage__reason">{stage.reason}</p> : null}
        {children ? <div className="recovery-stage__addon">{children}</div> : null}
      </div>
    </li>
  );
}

