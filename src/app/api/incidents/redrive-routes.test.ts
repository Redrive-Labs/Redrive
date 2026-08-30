import { describe, expect, it } from "vitest";
import { GET as getRedrive } from "@/app/api/incidents/[incidentId]/recovery/redrive/route";
import { POST as postPermit } from "@/app/api/incidents/[incidentId]/recovery/redrive-permit/route";

describe("redrive routes", () => {
  it("requires the existing operator session before redrive state or permit work", async () => {
    const context = { params: Promise.resolve({ incidentId: "incident-1" }) };
    const getResponse = await getRedrive(
      new Request("http://localhost/api/incidents/incident-1/recovery/redrive"),
      context,
    );
    const permitResponse = await postPermit(
      new Request("http://localhost/api/incidents/incident-1/recovery/redrive-permit", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fingerprint: "0".repeat(64) }),
      }),
      context,
    );

    expect(getResponse.status).toBe(401);
    expect(permitResponse.status).toBe(401);
  });
});
