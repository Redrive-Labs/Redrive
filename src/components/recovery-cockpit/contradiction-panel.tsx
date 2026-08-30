import { EvidenceBlock } from "./evidence-block";
import type { RecoveryCockpitViewModel } from "./types";

interface ContradictionPanelProps {
  provider?: RecoveryCockpitViewModel["provider"];
  receiver?: RecoveryCockpitViewModel["receiver"];
  assessment?: RecoveryCockpitViewModel["assessment"];
}

export function ContradictionPanel({
  provider,
  receiver,
  assessment,
}: ContradictionPanelProps) {
  const providerObserved = provider?.observed === true;
  const receiverObserved = receiver?.observed === true;
  const isContradiction =
    assessment?.contradiction === "PROVIDER_FAILED_RECEIVER_MUTATED" &&
    providerObserved &&
    provider.statusCode === 500 &&
    receiverObserved &&
    receiver.mutationCount === 1 &&
    receiver.businessState === "EXACTLY_ONE";

  return (
    <section className="contradiction-panel" aria-labelledby="contradiction-title">
      <div className="contradiction-panel__heading">
        <p className="mono-type section-kicker">Evidence comparison</p>
        <h2 className="display-type" id="contradiction-title">
          The contradiction
        </h2>
      </div>

      <div className="evidence-grid">
        <EvidenceBlock
          label="Provider evidence"
          source="GitHub"
          headline={providerObserved ? `HTTP ${provider.statusCode}` : "Pending"}
          detail={providerObserved ? (provider.statusCode >= 400 ? "Delivery failed" : provider.status) : "Provider observation has not been supplied."}
          observed={providerObserved}
          observedAt={providerObserved ? provider.observedAt : undefined}
          provenance={providerObserved ? provider.provenance : undefined}
          statusCode={providerObserved ? provider.statusCode : undefined}
        />
        <EvidenceBlock
          label="Receiver evidence"
          source="Independent receiver"
          headline={receiverObserved ? receiver.businessState : "Pending"}
          detail={
            receiverObserved
              ? `Mutation count: ${receiver.mutationCount}`
              : "Receiver observation has not been supplied."
          }
          observed={receiverObserved}
          observedAt={receiverObserved ? receiver.observedAt : undefined}
          provenance={receiverObserved ? receiver.provenance : undefined}
          mutationCount={receiverObserved ? receiver.mutationCount : undefined}
          businessState={receiverObserved ? receiver.businessState : undefined}
        />
      </div>

      <div className={`contradiction-reading${isContradiction ? " contradiction-reading--risk" : ""}`}>
        <p className="mono-type contradiction-reading__label">
          {isContradiction ? "The contradiction" : "Assessment"}
        </p>
        {isContradiction ? (
          <>
            <p className="display-type contradiction-reading__headline">Retry unsafe</p>
            <p className="contradiction-reading__copy">
              GitHub reports failure, but the receiver already mutated once.
            </p>
          </>
        ) : (
          <p className="contradiction-reading__copy">
            {receiver?.businessState === "ABSENT"
              ? "Receiver mutation state is absent. No retry interpretation is established."
              : "Waiting for independent provider and receiver evidence."}
          </p>
        )}
      </div>
    </section>
  );
}
