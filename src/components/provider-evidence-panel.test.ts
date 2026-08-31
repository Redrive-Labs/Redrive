import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  fetchProviderEvidence,
  ProviderEvidencePanel,
} from "./provider-evidence-panel";

describe("ProviderEvidencePanel evidence boundary", () => {
  it("keeps provider evidence read-only and does not offer uncaptured inspect POSTs", () => {
    const source = readFileSync(new URL("./provider-evidence-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain('{ method: "GET", cache: "no-store" }');
    expect(source).not.toContain('method: hasCaptured ? "GET" : "POST"');
    expect(source).toContain("Provider evidence has not been captured.");
  });

  it("renders truthful captured and uncaptured states", () => {
    const uncaptured = renderToStaticMarkup(
      createElement(ProviderEvidencePanel, { incidentId: "incident-uncaptured" }),
    );
    expect(uncaptured).toContain("Provider evidence has not been captured.");
    expect(uncaptured).not.toContain("Inspect provider delivery");
    expect(uncaptured).not.toContain("View captured evidence");

    const captured = renderToStaticMarkup(
      createElement(ProviderEvidencePanel, {
        incidentId: "incident-captured",
        initialCaptured: true,
      }),
    );
    expect(captured).toContain("View captured evidence");
  });

  it("opens existing captured evidence with a read-only GET", async () => {
    const evidence = { providerDeliveryId: "delivery-captured" };
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify({ evidence }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await expect(fetchProviderEvidence("incident/captured", request)).resolves.toEqual(evidence);
    expect(request).toHaveBeenCalledWith(
      "/api/incidents/incident%2Fcaptured/provider-evidence",
      { method: "GET", cache: "no-store" },
    );
  });
});
