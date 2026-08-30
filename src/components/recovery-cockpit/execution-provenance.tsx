import type { RecoveryCockpitViewModel } from "./types";

interface ExecutionProvenanceProps {
  viewModel: RecoveryCockpitViewModel;
}

function ProvenanceValue({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return (
    <div className="provenance-value">
      <dt>{label}</dt>
      <dd className="mono-type" title={value}>{value}</dd>
    </div>
  );
}

export function ExecutionProvenance({ viewModel }: ExecutionProvenanceProps) {
  const { provider, receiver, sandbox, provenance } = viewModel;
  const investigation = provenance?.investigation;
  const recovery = provenance?.recovery;
  const humanControl = provenance?.humanControl;
  const hasInvestigation = Boolean(
    provider?.provenance || receiver?.provenance || investigation,
  );
  const hasRecovery = Boolean(
    recovery || sandbox?.provenance || (sandbox && sandbox.state !== "NOT_STARTED"),
  );
  const hasHumanControl = Boolean(humanControl || viewModel.deployment || viewModel.redrive);
  const hasAnyProvenance = Boolean(
    hasInvestigation || hasRecovery || hasHumanControl,
  );

  return (
    <details className="execution-provenance">
      <summary>
        <span className="mono-type">Execution provenance</span>
        <span className="execution-provenance__summary">{hasAnyProvenance ? "View session and tool identities" : "Available when supplied by recovery state"}</span>
      </summary>
      {hasAnyProvenance ? (
        <div className="provenance-grid">
          {hasInvestigation ? <section className="provenance-section">
            <h3>Investigation</h3>
            <p>Persistent TrueForge session</p>
            <p>{investigation?.providerInvestigator ?? provider?.provenance?.investigator ?? "Provider Investigator"}</p>
            <p>{investigation?.receiverInvestigator ?? receiver?.provenance?.investigator ?? "Receiver Investigator"}</p>
            <dl>
              <ProvenanceValue label="Session" value={investigation?.trueForgeSessionId ?? provider?.provenance?.trueForgeSessionId ?? receiver?.provenance?.trueForgeSessionId} />
              <ProvenanceValue label="Turn" value={investigation?.turnId ?? provider?.provenance?.turnId ?? receiver?.provenance?.turnId} />
              <ProvenanceValue label="Provider tool" value={provider?.provenance?.toolName} />
              <ProvenanceValue label="Receiver tool" value={receiver?.provenance?.toolName} />
            </dl>
          </section> : null}
          {hasRecovery ? <section className="provenance-section">
            <h3>Recovery</h3>
            <p>Persistent Recovery Session</p>
            <p>Daytona sandbox</p>
            <dl>
              <ProvenanceValue label="Session" value={recovery?.trueForgeSessionId ?? sandbox?.provenance?.trueForgeSessionId} />
              <ProvenanceValue label="Turn" value={recovery?.turnId ?? sandbox?.provenance?.turnId} />
              <ProvenanceValue label="Sandbox" value={recovery?.sandboxId ?? sandbox?.provenance?.sandboxId} />
            </dl>
          </section> : null}
          {hasHumanControl ? <section className="provenance-section">
            <h3>Human control</h3>
            <p>DeployPermit</p>
            <p>RedrivePermit</p>
            <dl>
              <ProvenanceValue label="Deploy permit" value={humanControl?.deployPermitId} />
              <ProvenanceValue label="Redrive permit" value={humanControl?.redrivePermitId} />
            </dl>
          </section> : null}
        </div>
      ) : (
        <p className="provenance-empty">TrueForge, Daytona, and permit identities will appear here when the recovery adapter supplies them.</p>
      )}
    </details>
  );
}
