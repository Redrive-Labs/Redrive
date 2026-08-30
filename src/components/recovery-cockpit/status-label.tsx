import type { SpineStatus } from "./types";

interface StatusLabelProps {
  status: string;
  compact?: boolean;
}

function statusClass(status: string): string {
  switch (status) {
    case "VERIFIED":
    case "COMPLETE":
      return "status-label--verified";
    case "ACTIVE":
    case "WAITING_APPROVAL":
    case "FAILED":
    case "OUTCOME_UNKNOWN":
    case "RETRY BLOCKED":
    case "DEPLOYMENT BLOCKED":
    case "AWAITING DEPLOY APPROVAL":
    case "AWAITING REDRIVE APPROVAL":
    case "VERIFYING REDELIVERY":
      return "status-label--attention";
    case "RECOVERY COMPLETE":
    case "REPAIR VERIFIED":
    case "DEPLOYMENT VERIFIED":
      return "status-label--verified";
    case "LOCKED":
    case "PENDING":
    default:
      return "status-label--neutral";
  }
}

export function StatusLabel({ status, compact = false }: StatusLabelProps) {
  return (
    <span
      className={`status-label ${statusClass(status)}${compact ? " status-label--compact" : ""}`}
    >
      {status}
    </span>
  );
}

export function spineStatusLabel(status: SpineStatus): string {
  return status;
}
