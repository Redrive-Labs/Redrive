interface EvidenceDetailsProps {
  rows: Array<{ label: string; value: string | number | undefined }>;
  summary?: string;
}

export function EvidenceDetails({
  rows,
  summary = "Evidence →",
}: EvidenceDetailsProps) {
  const visibleRows = rows.filter((row) => row.value !== undefined);

  if (visibleRows.length === 0) return null;

  return (
    <details className="evidence-details">
      <summary>{summary}</summary>
      <dl className="evidence-details__list">
        {visibleRows.map((row) => (
          <div className="evidence-details__row" key={row.label}>
            <dt>{row.label}</dt>
            <dd className="mono-type">{row.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

