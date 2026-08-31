import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FailedDeliveryList } from "./failed-delivery-list";

const deliveries = [
  {
    id: "900719925474099312345",
    guid: "guid-a",
    status: "Failed",
    statusCode: 500,
    deliveredAt: "2026-08-31T10:00:00.000Z",
    event: "push",
    redelivery: false,
  },
  {
    id: "delivery-b",
    guid: null,
    status: "Failed",
    statusCode: 502,
    deliveredAt: null,
    event: "issues",
    redelivery: true,
  },
];

describe("FailedDeliveryList", () => {
  it("renders opaque IDs, statuses, events, and an action for every delivery", () => {
    const html = renderToStaticMarkup(
      createElement(FailedDeliveryList, {
        creatingIncidentFor: null,
        deliveries,
        onSelect: vi.fn(),
      }),
    );

    expect(html).toContain("900719925474099312345");
    expect(html).toContain("delivery-b");
    expect(html).toContain("Failed");
    expect(html).toContain("push");
    expect(html).toContain("issues");
    expect((html.match(/Investigate delivery/g) ?? [])).toHaveLength(2);
  });

  it("keeps delivery IDs and actions contained by their dedicated list classes", () => {
    const source = readFileSync(new URL("./failed-delivery-list.tsx", import.meta.url), "utf8");

    expect(source).toContain("failed-delivery-list");
    expect(source).toContain("failed-delivery-list__id");
    expect(source).toContain("failed-delivery-list__action");
    expect(source).toContain("min-w-0");
    expect(source).toContain("break-all");
  });
});
