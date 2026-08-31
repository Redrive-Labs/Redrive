export interface FailedDelivery {
  id: string;
  guid: string | null;
  status: string;
  statusCode: number | null;
  deliveredAt: string | null;
  event: string | null;
  redelivery: boolean | null;
}

interface ErrorResponse {
  error?: string;
}

interface DeliveriesResponse {
  deliveries?: FailedDelivery[];
}

interface IncidentResponse {
  incident?: { id?: string };
}

export type LatestRequestLoader<T> = (
  key: string,
  signal: AbortSignal,
) => Promise<T>;

export function createLatestRequestOrchestrator<T>(loader: LatestRequestLoader<T>) {
  let generation = 0;
  let activeController: AbortController | null = null;

  return {
    invalidate(): void {
      generation += 1;
      activeController?.abort();
      activeController = null;
    },
    async run(key: string): Promise<{ current: boolean; value?: T }> {
      const requestGeneration = ++generation;
      activeController?.abort();
      const controller = new AbortController();
      activeController = controller;
      try {
        const value = await loader(key, controller.signal);
        return requestGeneration === generation
          ? { current: true, value }
          : { current: false };
      } catch (error) {
        if (requestGeneration !== generation) return { current: false };
        throw error;
      } finally {
        if (requestGeneration === generation) activeController = null;
      }
    },
  };
}

/** Fences non-abortable connection-bound POST completions after a UI switch. */
export function createConnectionRequestFence() {
  let generation = 0;
  let activeConnectionId: string | null = null;

  return {
    activate(connectionId: string | null): void {
      generation += 1;
      activeConnectionId = connectionId;
    },
    begin(connectionId: string): { connectionId: string; generation: number } {
      generation += 1;
      return { connectionId, generation };
    },
    isCurrent(request: { connectionId: string; generation: number }): boolean {
      return request.generation === generation && request.connectionId === activeConnectionId;
    },
  };
}

export function createConnectionBoundIncidentController(input: {
  create: (connectionId: string, deliveryId: string) => Promise<string>;
  navigate: (incidentId: string) => void;
  setError: (value: string | null) => void;
  setPending: (value: string | null) => void;
}) {
  const fence = createConnectionRequestFence();
  return {
    activate(connectionId: string | null): void {
      fence.activate(connectionId);
      input.setError(null);
      input.setPending(null);
    },
    async open(connectionId: string, deliveryId: string): Promise<void> {
      const request = fence.begin(connectionId);
      input.setPending(deliveryId);
      input.setError(null);
      try {
        const incidentId = await input.create(connectionId, deliveryId);
        if (fence.isCurrent(request)) input.navigate(incidentId);
      } catch (reason) {
        if (fence.isCurrent(request)) {
          input.setError(reason instanceof Error ? reason.message : "The incident could not be recorded.");
        }
      } finally {
        if (fence.isCurrent(request)) input.setPending(null);
      }
    },
  };
}

function responseError(value: unknown, fallback: string): string {
  return value !== null && typeof value === "object" && "error" in value &&
    typeof value.error === "string" && value.error.length > 0
    ? value.error
    : fallback;
}

export async function fetchFailedDeliveries(
  connectionId: string,
  request: typeof fetch = fetch,
  signal?: AbortSignal,
): Promise<FailedDelivery[]> {
  const response = await request(
    `/api/integrations/github/connections/${encodeURIComponent(connectionId)}/deliveries`,
    { cache: "no-store", signal },
  );
  const result = await response.json().catch(() => null) as DeliveriesResponse | ErrorResponse | null;
  if (!response.ok) throw new Error(responseError(result, "Failed deliveries could not be loaded."));
  if (result === null || !("deliveries" in result) || !Array.isArray(result.deliveries)) {
    throw new Error("Failed deliveries response was invalid.");
  }
  return result.deliveries;
}

export async function createIncidentFromDelivery(
  connectionId: string,
  deliveryId: string,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request(
    `/api/integrations/github/connections/${encodeURIComponent(connectionId)}/incidents`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deliveryId }),
    },
  );
  const result = await response.json().catch(() => null) as IncidentResponse & ErrorResponse | null;
  if (!response.ok) throw new Error(responseError(result, `Incident creation failed with HTTP ${response.status}.`));
  const incidentId = result?.incident?.id;
  if (typeof incidentId !== "string" || incidentId.length === 0) {
    throw new Error("Incident creation response was invalid.");
  }
  return incidentId;
}

export async function investigateIncident(
  incidentId: string,
  request: typeof fetch = fetch,
  reload?: () => void,
): Promise<void> {
  const response = await request(
    `/api/incidents/${encodeURIComponent(incidentId)}/provider-investigation`,
    { method: "POST" },
  );
  const result = await response.json().catch(() => null) as ErrorResponse | null;
  if (!response.ok) {
    throw new Error(responseError(result, `Provider investigation failed with HTTP ${response.status}.`));
  }
  reload?.();
}

export function incidentCockpitHref(incidentId: string): string {
  return `/?incidentId=${encodeURIComponent(incidentId)}#incident-cockpit`;
}
