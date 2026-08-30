import { NextResponse } from "next/server";
import { getIncidentById } from "@/server/incidents/incident-service";
import { getProviderEvidenceByIncidentId } from "@/server/incidents/provider-evidence-service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProviderEvidenceRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function GET(
  _request: Request,
  context: ProviderEvidenceRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;

  try {
    // Check incident existence separately: a missing capture is not an incident miss.
    const incident = await getIncidentById(incidentId);
    if (incident === null) {
      return NextResponse.json(
        { error: "Incident not found." },
        { status: 404 },
      );
    }

    const evidence = await getProviderEvidenceByIncidentId(incidentId);
    return NextResponse.json({ evidence });
  } catch (error) {
    return providerEvidenceErrorResponse(
      error,
      "Unable to read provider evidence.",
    );
  }
}


function providerEvidenceErrorResponse(
  _error: unknown,
  fallback: string,
): Response {
  console.error(fallback, _error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
