"use client";

import { useState } from "react";
import type { ProviderEvidence } from "@/domain/provider-evidence";

interface ProviderEvidenceResponse {
  evidence?: ProviderEvidence;
  error?: string;
}

interface ProviderEvidencePanelProps {
  incidentId: string;
}

function formatPayload(payload: unknown): string {
  return JSON.stringify(payload, null, 2);
}

export function ProviderEvidencePanel({
  incidentId,
}: ProviderEvidencePanelProps) {
  const [evidence, setEvidence] = useState<ProviderEvidence | null>(null);
  const [isInspecting, setIsInspecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function inspectDelivery() {
    setError(null);
    setIsInspecting(true);

    try {
      const response = await fetch(
        `/api/incidents/${encodeURIComponent(incidentId)}/provider-evidence`,
        { cache: "no-store" },
      );
      const result = (await response.json().catch(() => null)) as
        | ProviderEvidenceResponse
        | null;

      if (!response.ok || result?.evidence === undefined) {
        setError(result?.error ?? "Provider evidence could not be loaded.");
        return;
      }

      setEvidence(result.evidence);
    } catch {
      setError("Provider evidence could not be loaded. Try again.");
    } finally {
      setIsInspecting(false);
    }
  }

  return (
    <div className="mt-5 border-t border-[var(--line)] pt-4">
      <button
        className="inline-flex min-h-10 items-center border border-[var(--ink)] px-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--ink)] transition-colors hover:bg-[var(--ink)] hover:text-[var(--paper-bright)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-wait disabled:opacity-60"
        disabled={isInspecting}
        onClick={inspectDelivery}
        type="button"
      >
        {isInspecting ? "Inspecting…" : "Inspect provider delivery"}
      </button>

      {error ? (
        <p className="mt-3 text-sm text-[var(--accent-deep)]" role="alert">
          {error}
        </p>
      ) : null}

      {evidence ? (
        <section
          aria-label="Provider delivery evidence"
          className="mt-4 grid gap-4 bg-[var(--paper)] p-4 sm:grid-cols-2"
        >
          <div>
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Delivery
            </p>
            <p className="mono-type mt-1 break-all text-sm">
              {evidence.deliveryId}
            </p>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {evidence.event} · {evidence.outcome.status} · status code {" "}
              {evidence.outcome.statusCode ?? "not returned"}
            </p>
          </div>
          <div>
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Captured
            </p>
            <p className="mt-1 text-sm">{evidence.deliveredAt}</p>
            <p className="mt-1 break-all text-xs text-[var(--muted)]">
              payload sha256: {evidence.request.payloadSha256}
            </p>
          </div>
          <div className="sm:col-span-2">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Request payload
            </p>
            <pre className="mt-2 max-h-56 overflow-auto border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5">
              {formatPayload(evidence.request.payload)}
            </pre>
          </div>
          <div className="sm:col-span-2">
            <p className="mono-type text-[10px] uppercase tracking-[0.14em] text-[var(--muted)]">
              Provider response
            </p>
            <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap border border-[var(--line)] bg-[var(--paper-bright)] p-3 text-xs leading-5">
              {evidence.response.body ?? "No response body returned."}
            </pre>
          </div>
        </section>
      ) : null}
    </div>
  );
}
