import { EvidenceDetails } from "./evidence-details";
import { formatUtcTimestamp } from "./format-utc";
import type { EvidenceProvenance } from "./types";

interface EvidenceBlockProps {
  label: string;
  source: string;
  headline: string;
  detail: string;
  observed: boolean;
  observedAt?: string;
  provenance?: EvidenceProvenance;
  statusCode?: number;
  mutationCount?: number;
  businessState?: string;
}

export function EvidenceBlock({
  label,
  source,
  headline,
  detail,
  observed,
  observedAt,
  provenance,
  statusCode,
  mutationCount,
  businessState,
}: EvidenceBlockProps) {
  return (
    <section className="evidence-block" aria-label={label}>
      <div className="evidence-block__topline">
        <p className="mono-type evidence-block__label">{label}</p>
        <span className="evidence-block__mark" aria-hidden="true">
          {observed ? "✓" : "—"}
        </span>
      </div>
      <p className="evidence-block__source">{source}</p>
      <p className="mono-type evidence-block__headline">{headline}</p>
      <p className="evidence-block__detail">{detail}</p>
      <p className="mono-type evidence-block__capture">
        {observed ? "Evidence captured" : "Evidence pending"}
      </p>
      <EvidenceDetails
        rows={[
          { label: "Status code", value: statusCode },
          { label: "Mutation count", value: mutationCount },
          { label: "Business state", value: businessState },
          { label: "Observed at", value: formatUtcTimestamp(observedAt) ?? undefined },
          { label: "TrueForge session", value: provenance?.trueForgeSessionId },
          { label: "Turn", value: provenance?.turnId },
          { label: "Investigator", value: provenance?.investigator },
          { label: "MCP tool", value: provenance?.toolName },
          { label: "Delivery GUID", value: provenance?.deliveryGuid },
        ]}
      />
    </section>
  );
}
