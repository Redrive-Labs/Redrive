import { formatUtcTimestamp } from "./format-utc";
import { StatusLabel } from "./status-label";
import type { RecoveryCockpitViewModel } from "./types";

interface IncidentDossierHeaderProps {
  incident: RecoveryCockpitViewModel["incident"];
  status: string;
}

export function IncidentDossierHeader({
  incident,
  status,
}: IncidentDossierHeaderProps) {
  const createdAt = formatUtcTimestamp(incident.createdAt);
  const eventLabel = incident.event?.toLowerCase().startsWith("github ")
    ? incident.event
    : `GitHub ${incident.event ?? "webhook"}`;
  const deliveryLabel = incident.deliveryId.toLowerCase().startsWith("delivery")
    ? incident.deliveryId
    : `delivery ${incident.deliveryId}`;

  return (
    <header className="dossier-header">
      <div className="dossier-header__row">
        <div className="dossier-header__identity">
          <p className="section-kicker">Incident</p>
          <h1 className="dossier-header__title">
            {eventLabel}
            <span aria-hidden="true"> · </span>
            <span className="mono-type dossier-header__delivery" title={incident.deliveryId}>
              {deliveryLabel}
            </span>
          </h1>
          <p className="dossier-header__metadata">
            <span>Incident </span><span className="mono-type">{incident.repository}</span>
            {createdAt ? <><span aria-hidden="true"> · </span><time className="mono-type dossier-header__time" dateTime={incident.createdAt}>{createdAt}</time></> : null}
          </p>
        </div>
        <StatusLabel status={status} />
      </div>
    </header>
  );
}

