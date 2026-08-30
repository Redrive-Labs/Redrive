import { formatUtcTimestamp } from "./format-utc";
import type { RecoveryCockpitViewModel } from "./types";

interface RecoveryReceiptProps {
  receipt?: RecoveryCockpitViewModel["receipt"];
}

export function RecoveryReceipt({ receipt }: RecoveryReceiptProps) {
  if (!receipt || receipt.outcome !== "RECOVERY_COMPLETE") return null;

  const rows = [
    ["Original delivery", `HTTP ${receipt.originalProviderStatusCode}`],
    ["Receiver before", `EXACTLY_ONE · count ${receipt.originalReceiverMutationCount}`],
    ["Sandbox retry", `HTTP ${receipt.sandboxRetryStatusCode} · count ${receipt.sandboxRetryMutationCount}`],
    ["Deployment", `VERIFIED · HTTP ${receipt.deploymentHealthStatusCode}`],
    ["GitHub redelivery", `HTTP ${receipt.redeliveryProviderStatusCode}`],
    ["Receiver final", `${receipt.finalReceiverBusinessState} · count ${receipt.finalReceiverMutationCount}`],
  ] as const;

  return (
    <section className="recovery-receipt" aria-labelledby="recovery-receipt-title">
      <div className="recovery-receipt__heading">
        <div>
          <p className="mono-type recovery-receipt__kicker">Recovery receipt</p>
          <p className="recovery-receipt__complete">Recovery complete</p>
          <h2 id="recovery-receipt-title">Retried once. Mutated once.</h2>
        </div>
        {receipt.id ? <p className="mono-type recovery-receipt__id" title={receipt.id}>{receipt.id}</p> : null}
      </div>
      <dl className="receipt-rows">
        {rows.map(([label, value]) => (
          <div key={label}><dt>{label}</dt><dd className="mono-type">{value}</dd></div>
        ))}
      </dl>
      {receipt.createdAt ? <time className="mono-type recovery-receipt__time" dateTime={receipt.createdAt}>{formatUtcTimestamp(receipt.createdAt)}</time> : null}
    </section>
  );
}
