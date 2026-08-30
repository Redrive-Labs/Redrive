import { IncidentForm } from "@/components/incident-form";
import { formatUtcTimestamp } from "@/components/recovery-cockpit/format-utc";
import { GithubConnectionFlow } from "@/components/github-connection-flow";
import { ProviderEvidencePanel } from "@/components/provider-evidence-panel";
import { RecoveryCockpit } from "@/components/recovery-cockpit/recovery-cockpit";
import { buildRecoveryCockpitViewModel } from "@/server/recovery-cockpit-view-model";
import { listIncidents } from "@/server/incident-service";
import { getProviderEvidenceCaptureStatus } from "@/server/provider-evidence-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export default async function Home() {
  const incidents = await listIncidents();
  const capturedIncidentIds = await getProviderEvidenceCaptureStatus(
    incidents.map((incident) => incident.id),
  );
  const selectedIncident = incidents[0];
  const selectedViewModel = selectedIncident
    ? await buildRecoveryCockpitViewModel(selectedIncident)
    : null;

  return (
    <main className="cockpit-frame">
      <header className="site-header">
        <div className="site-header__brand">
          <span className="site-header__mark">R</span>
          <div>
            <p className="site-header__name">Redrive</p>
            <p className="mono-type site-header__role">Control plane</p>
          </div>
        </div>
        <p className="site-header__thesis">Failed doesn&apos;t mean safe to retry.</p>
        <div className="site-header__runtime" aria-label="Integration surfaces">
          <span><b>GitHub</b><em>integration</em></span>
          <span><b>Receiver</b><em>runtime</em></span>
        </div>
      </header>

      <section className="integration-strip" aria-label="Integration state">
        <p className="mono-type section-kicker">Integration state</p>
        <p>GitHub connection and receiver health remain available in setup.</p>
        <a href="#github-connection">View setup ↓</a>
      </section>

      {selectedViewModel ? (
        <RecoveryCockpit viewModel={selectedViewModel} />
      ) : (
        <section className="empty-dossier" aria-labelledby="empty-dossier-title">
          <p className="mono-type section-kicker">Incident dossier</p>
          <h1 className="display-type" id="empty-dossier-title">No incident selected.</h1>
          <p>Record a failed delivery below to establish the incident identity.</p>
        </section>
      )}

      <section className="incident-index" id="incidents" aria-labelledby="incident-index-title">
        <div className="incident-index__header">
          <div>
            <p className="mono-type section-kicker">Secondary records</p>
            <h2 id="incident-index-title">Recent incidents</h2>
          </div>
          <span className="mono-type incident-index__count">{String(incidents.length).padStart(2, "0")}</span>
        </div>

        {incidents.length > 0 ? (
          <div className="incident-list">
            {incidents.map((incident) => (
              <article className="incident-row" key={incident.id}>
                <div className="incident-row__main">
                  <div className="incident-row__title">
                    <strong>{incident.repositoryId}</strong>
                    <span className="mono-type">{incident.provider} delivery</span>
                  </div>
                  <p className="mono-type incident-row__delivery" title={incident.externalDeliveryId}>
                    {incident.externalDeliveryId}
                  </p>
                  <p className="incident-row__state">
                    {capturedIncidentIds.has(incident.id) ? "Evidence captured" : "Evidence pending"}
                    <span aria-hidden="true"> · </span>Recovery pending
                  </p>
                  <ProviderEvidencePanel
                    incidentId={incident.id}
                    initialCaptured={capturedIncidentIds.has(incident.id)}
                  />
                </div>
                <time className="mono-type incident-row__time" dateTime={incident.createdAt}>
                  {formatUtcTimestamp(incident.createdAt)}
                </time>
              </article>
            ))}
          </div>
        ) : (
          <div className="empty-list">
            <p className="display-type">No incidents recorded yet.</p>
            <p>Use development capture below to record an incident identity. It does not start recovery work.</p>
          </div>
        )}
      </section>

      <section className="setup-area" aria-labelledby="setup-title">
        <div className="setup-area__intro">
          <p className="mono-type section-kicker">Secondary setup</p>
          <h2 className="display-type" id="setup-title">Connect the evidence sources.</h2>
          <p>GitHub connection, receiver enrollment, and development capture stay available here while the selected incident remains primary.</p>
        </div>
        <details className="setup-disclosure" id="github-connection" open={incidents.length === 0}>
          <summary>GitHub connection &amp; receiver enrollment <span aria-hidden="true">↓</span></summary>
          <GithubConnectionFlow />
        </details>
      </section>

      <section className="capture-area" aria-labelledby="capture-title">
        <div>
          <p className="mono-type section-kicker">Development capture</p>
          <h2 className="display-type" id="capture-title">Record an incident identity.</h2>
          <p>This creates a local Redrive record. It does not claim provider evidence or start recovery work until the linked delivery is inspected.</p>
        </div>
        <IncidentForm />
      </section>
    </main>
  );
}
