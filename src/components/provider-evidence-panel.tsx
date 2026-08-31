"use client";

import { useState } from "react";
import type { ProviderEvidence } from "@/domain/provider-evidence";

interface ProviderEvidenceResponse {
  evidence?: ProviderEvidence;
  error?: string;
}

interface ProviderEvidencePanelProps {
  incidentId: string;
  initialCaptured?: boolean;
}

function formatPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export async function fetchProviderEvidence(
  incidentId: string,
  request: typeof fetch = fetch,
): Promise<ProviderEvidence | null> {
  const response = await request(
    `/api/incidents/${encodeURIComponent(incidentId)}/provider-evidence`,
    { method: "GET", cache: "no-store" },
  );
  const result = (await response.json().catch(() => null)) as
    | ProviderEvidenceResponse
    | null;
  if (!response.ok || result?.evidence === undefined) {
    throw new Error(result?.error ?? "Provider evidence could not be loaded.");
  }
  return result.evidence ?? null;
}

export function ProviderEvidencePanel({
  incidentId,
  initialCaptured = false,
}: ProviderEvidencePanelProps) {
  const [evidence, setEvidence] = useState<ProviderEvidence | null>(null);
  const [hasCaptured, setHasCaptured] = useState(initialCaptured);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadEvidence() {
    setError(null);
    setIsLoading(true);

    try {
      const capturedEvidence = await fetchProviderEvidence(incidentId);
      setEvidence(capturedEvidence);
      setHasCaptured(capturedEvidence !== null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Provider evidence could not be loaded. Try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <div className="mt-5 min-w-0 max-w-full border-t border-[var(--line)] pt-4">
      {hasCaptured ? <button
        className="inline-flex min-h-10 items-center border border-[var(--ink)] px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink)] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper-bright)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
        disabled={isLoading}
        onClick={loadEvidence}
        type="button"
      >
        {isLoading ? "Loading…" : "View captured evidence"}
      </button>
      : (
        <p className="text-sm text-[var(--muted)]">Provider evidence has not been captured. Open the incident cockpit to investigate through TrueForge.</p>
      )}

      {error ? (
        <p className="mt-3 text-sm text-[var(--accent-deep)]" role="alert">
          {error}
        </p>
      ) : null}

      {evidence ? (
        <section
          aria-label="Provider delivery evidence"
          className="mt-4 grid min-w-0 max-w-full gap-4 bg-[var(--paper)] p-4 sm:grid-cols-2"
        >
          <div className="min-w-0">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Delivery
            </p>
            <p className="mono-type mt-1 break-all text-sm">
              {evidence.providerDeliveryId}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {evidence.deliveryGuid} · {evidence.event} · {evidence.outcome.status} ·
              status code {" "}
              {evidence.outcome.statusCode ?? "not returned"}
            </p>
          </div>
          <div className="min-w-0">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Captured
            </p>
            <p className="mt-1 text-sm">{evidence.deliveredAt}</p>
            <p className="mt-1 break-all text-xs text-[var(--muted)]">
              canonical JSON sha256: {evidence.request.canonicalPayloadSha256}
            </p>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Request payload
            </p>
            <pre className="mt-2 max-h-56 min-w-0 max-w-full overflow-x-auto overflow-y-auto border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5">
              {formatPayload(evidence.request.payload)}
            </pre>
          </div>
          <div className="min-w-0 sm:col-span-2">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Provider response
            </p>
            <pre className="mt-2 max-h-32 min-w-0 max-w-full overflow-x-auto overflow-y-auto whitespace-pre-wrap break-words border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5">
              {evidence.response.body ?? "No response body returned."}
            </pre>
          </div>
        </section>
      ) : null}
    </div>
  );
}
