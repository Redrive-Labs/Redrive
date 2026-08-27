import { IncidentForm } from "@/components/incident-form";
import { ProviderEvidencePanel } from "@/components/provider-evidence-panel";
import { listIncidents } from "@/server/incident-service";
import {
  getProviderEvidenceByIncidentId,
} from "@/server/provider-evidence-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default async function Home() {
  const incidents = await listIncidents();
  const evidenceByIncidentId = new Map(
    await Promise.all(
      incidents.map(async (incident) => [
        incident.id,
        await getProviderEvidenceByIncidentId(incident.id),
      ] as const),
    ),
  );

  return (
    <main className="mx-auto min-h-screen w-full max-w-6xl px-5 py-6 sm:px-8 sm:py-10">
      <header className="flex items-center justify-between border-b border-[var(--line)] pb-5">
        <div className="flex items-center gap-3">
          <span className="flex size-9 items-center justify-center bg-[var(--accent)] text-sm font-bold text-[var(--paper-bright)]">
            R
          </span>
          <div>
            <p className="text-sm font-bold tracking-tight">Redrive</p>
            <p className="mono-type text-[10px] uppercase tracking-[0.18em] text-[var(--muted)]">
              Control plane
            </p>
          </div>
        </div>
        <span className="mono-type hidden text-[10px] uppercase tracking-[0.16em] text-[var(--muted)] sm:block">
          Foundation / 002A
        </span>
      </header>

      <section className="grid gap-10 border-b border-[var(--line)] py-14 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-end lg:gap-16 lg:py-20">
        <div className="max-w-3xl">
          <p className="mono-type mb-5 text-xs font-semibold uppercase tracking-[0.18em] text-[var(--accent-deep)]">
            Recovery incident foundation
          </p>
          <h1 className="display-type max-w-2xl text-5xl leading-[0.96] sm:text-7xl">
            A deliberate place for the next replay.
          </h1>
          <p className="mt-7 max-w-xl text-base leading-7 text-[var(--muted)] sm:text-lg">
            Redrive is the control plane for investigating ambiguous webhook
            failures before anything consequential happens. Inspect a captured
            GitHub delivery before any consequential recovery action.
          </p>
        </div>

        <aside className="border-l-2 border-[var(--accent)] pl-5">
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">
            Current foundation
          </p>
          <p className="mt-2 text-xl font-semibold tracking-tight">
            SQLite + provider evidence
          </p>
          <p className="mt-1 text-sm leading-6 text-[var(--muted)]">
            {incidents.length} recent{" "}
            {incidents.length === 1 ? "incident" : "incidents"} shown
          </p>
        </aside>
      </section>

      <section className="py-12 sm:py-16" id="incidents">
        <div className="mb-5 flex items-baseline justify-between gap-4">
          <div>
            <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">
              Redrive-owned records
            </p>
            <h2 className="mt-2 text-2xl font-semibold tracking-tight">
              Incidents
            </h2>
          </div>
          <span className="mono-type text-xs text-[var(--muted)]">
            {String(incidents.length).padStart(2, "0")}
          </span>
        </div>

        {incidents.length > 0 ? (
          <div className="overflow-hidden border border-[var(--line)] bg-[var(--paper-bright)]">
            <ul className="divide-y divide-[var(--line)]">
              {incidents.map((incident) => (
                <li
                  className="grid gap-4 px-4 py-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6"
                  key={incident.id}
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="bg-[var(--accent-wash)] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.14em] text-[var(--accent-deep)]">
                        {incident.status}
                      </span>
                      <span className="text-sm font-semibold">
                        {incident.provider}
                      </span>
                    </div>
                    <p className="mono-type mt-3 break-all text-sm text-[var(--ink)]">
                      {incident.externalDeliveryId}
                    </p>
                    <p className="mt-2 text-sm text-[var(--muted)]">
                      {incident.repositoryId}
                    </p>
                    <ProviderEvidencePanel
                      incidentId={incident.id}
                      initialEvidence={
                        evidenceByIncidentId.get(incident.id) ?? null
                      }
                    />
                  </div>
                  <time
                    className="text-xs text-[var(--muted)] sm:text-right"
                    dateTime={incident.createdAt}
                  >
                    {formatDate(incident.createdAt)}
                  </time>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="border border-dashed border-[var(--line)] bg-[rgba(251,250,245,0.55)] px-5 py-12 sm:px-8">
            <p className="display-type text-3xl">No incidents recorded yet.</p>
            <p className="mt-3 max-w-md text-sm leading-6 text-[var(--muted)]">
              Use the development capture below to record an incident identity.
              Inspecting provider evidence is a separate read-only action.
            </p>
          </div>
        )}
      </section>

      <section className="grid gap-8 border-t border-[var(--line)] py-12 sm:py-16 lg:grid-cols-[minmax(0,1fr)_24rem] lg:gap-16">
        <div>
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--accent-deep)]">
            Development capture
          </p>
          <h2 className="display-type mt-3 text-4xl leading-none">
            Record an incident identity.
          </h2>
          <p className="mt-5 max-w-lg text-sm leading-6 text-[var(--muted)]">
            This small form creates a local Redrive record. It does not claim
            provider delivery evidence or start recovery work until you inspect
            the linked GitHub delivery.
          </p>
        </div>
        <IncidentForm />
      </section>
    </main>
  );
}
