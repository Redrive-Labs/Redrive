import { NextResponse } from "next/server";
import { GithubMcpConfigurationError } from "@/server/github-mcp";
import { getIncidentById } from "@/server/incident-service";
import { GithubDeliveryNormalizationError } from "@/server/github-provider-evidence";
import {
  IncidentNotFoundError,
  ProviderEvidenceReadError,
  UnsupportedProviderEvidenceError,
  getProviderEvidenceByIncidentId,
  inspectProviderEvidence,
} from "@/server/provider-evidence-service";

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

export async function POST(
  _request: Request,
  context: ProviderEvidenceRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;

  try {
    const evidence = await inspectProviderEvidence(incidentId);
    return NextResponse.json({ evidence });
  } catch (error) {
    return providerEvidenceErrorResponse(
      error,
      "Unable to inspect provider evidence.",
    );
  }
}

function providerEvidenceErrorResponse(
  error: unknown,
  fallback: string,
): Response {
  if (error instanceof IncidentNotFoundError) {
    return NextResponse.json(
      { error: "Incident not found." },
      { status: 404 },
    );
  }

  if (error instanceof UnsupportedProviderEvidenceError) {
    return NextResponse.json(
      { error: "Provider evidence is not supported for this incident." },
      { status: 422 },
    );
  }

  if (error instanceof GithubDeliveryNormalizationError) {
    return NextResponse.json(
      { error: "GitHub provider evidence was malformed or mismatched." },
      { status: 422 },
    );
  }

  if (
    error instanceof ProviderEvidenceReadError &&
    error.cause instanceof GithubMcpConfigurationError
  ) {
    return NextResponse.json(
      { error: "GitHub provider inspection is not configured." },
      { status: 503 },
    );
  }

  if (error instanceof ProviderEvidenceReadError) {
    return NextResponse.json(
      { error: "GitHub provider delivery could not be read." },
      { status: 502 },
    );
  }

  console.error(fallback, error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}
