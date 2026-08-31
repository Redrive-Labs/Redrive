import type { FailedDelivery } from "./incident-investigation-client";

interface FailedDeliveryListProps {
  deliveries: FailedDelivery[];
  creatingIncidentFor: string | null;
  onSelect: (deliveryId: string) => void;
}

export function FailedDeliveryList({
  deliveries,
  creatingIncidentFor,
  onSelect,
}: FailedDeliveryListProps) {
  return (
    <ul className="failed-delivery-list mt-4 grid min-w-0 gap-2" aria-label="Failed GitHub deliveries">
      {deliveries.map((delivery) => (
        <li className="flex min-w-0 flex-wrap items-center justify-between gap-3 border border-[var(--line)] bg-[var(--paper-bright)] p-3" key={delivery.id}>
          <div className="min-w-0">
            <p className="failed-delivery-list__id mono-type break-all text-sm" title={delivery.id}>{delivery.id}</p>
            <p className="mt-1 break-words text-xs text-[var(--muted)]">
              {delivery.status} · {delivery.event ?? "GitHub webhook"} · {delivery.statusCode === null ? "status unknown" : `HTTP ${delivery.statusCode}`}
              {delivery.deliveredAt ? ` · ${delivery.deliveredAt}` : ""}
            </p>
          </div>
          <button
            className="failed-delivery-list__action min-h-10 shrink-0 border border-[var(--ink)] px-3 text-xs font-semibold uppercase tracking-[0.08em] hover:bg-[var(--ink)] hover:text-[var(--paper-bright)] disabled:cursor-wait disabled:opacity-60"
            disabled={creatingIncidentFor !== null}
            onClick={() => onSelect(delivery.id)}
            type="button"
          >
            {creatingIncidentFor === delivery.id ? "Recording…" : "Investigate delivery"}
          </button>
        </li>
      ))}
    </ul>
  );
}
