import { describe, expect, it, vi } from "vitest";
import {
  createLatestRequestOrchestrator,
  createIncidentFromDelivery,
  fetchFailedDeliveries,
  incidentCockpitHref,
  investigateIncident,
} from "./incident-investigation-client";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("incident investigation client", () => {
  it("loads all failed deliveries for a connection without changing opaque IDs", async () => {
    const request = vi.fn<typeof fetch>(async () => response({
      deliveries: [
        { id: "900719925474099312345", guid: "guid-a", status: "Failed", statusCode: 500, deliveredAt: null, event: "push", redelivery: false },
        { id: "delivery-b", guid: null, status: "Failed", statusCode: 502, deliveredAt: null, event: "issues", redelivery: true },
      ],
    }));

    await expect(fetchFailedDeliveries("connection/a", request)).resolves.toHaveLength(2);
    expect(request).toHaveBeenCalledWith(
      "/api/integrations/github/connections/connection%2Fa/deliveries",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("creates a connection-bound incident with exactly the delivery ID body", async () => {
    const request = vi.fn<typeof fetch>(async () => response({
      incident: { id: "incident/created" },
    }, 201));

    await expect(createIncidentFromDelivery("connection-1", "delivery-001", request))
      .resolves.toBe("incident/created");
    expect(request).toHaveBeenCalledWith(
      "/api/integrations/github/connections/connection-1/incidents",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ deliveryId: "delivery-001" }),
      }),
    );
  });

  it("builds the encoded cockpit query and hash", () => {
    expect(incidentCockpitHref("incident/a?b")).toBe(
      "/?incidentId=incident%2Fa%3Fb#incident-cockpit",
    );
  });

  it("posts provider investigation and surfaces route errors", async () => {
    const success = vi.fn<typeof fetch>(async () => response({ incident: { id: "incident-1" } }));
    const reload = vi.fn();
    await expect(investigateIncident("incident-1", success, reload)).resolves.toBeUndefined();
    expect(success).toHaveBeenCalledWith(
      "/api/incidents/incident-1/provider-investigation",
      { method: "POST" },
    );
    expect(reload).toHaveBeenCalledTimes(1);

    const failure = vi.fn<typeof fetch>(async () => response({ error: "TrueForge is unavailable." }, 503));
    const failedReload = vi.fn();
    await expect(investigateIncident("incident-1", failure, failedReload)).rejects.toThrow("TrueForge is unavailable.");
    expect(failedReload).not.toHaveBeenCalled();
  });

  it("commits only the latest deferred delivery request and aborts the previous one", async () => {
    let resolveA!: (value: string) => void;
    let resolveB!: (value: string) => void;
    const loader = vi.fn((key: string, _signal: AbortSignal) => {
      if (key === "A") return new Promise<string>((resolve) => { resolveA = resolve; });
      return new Promise<string>((resolve) => { resolveB = resolve; });
    });
    const orchestrator = createLatestRequestOrchestrator(loader);

    const requestA = orchestrator.run("A");
    const requestB = orchestrator.run("B");
    expect(loader).toHaveBeenCalledTimes(2);

    resolveB("result-b");
    await expect(requestB).resolves.toEqual({ current: true, value: "result-b" });

    resolveA("result-a");
    await expect(requestA).resolves.toEqual({ current: false });
    expect(loader.mock.calls[0]?.[1].aborted).toBe(true);
  });
});
