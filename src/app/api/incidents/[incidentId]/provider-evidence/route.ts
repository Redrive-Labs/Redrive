import { NextResponse } from "next/server";
import { GithubMcpConfigurationError } from "@/server/github-mcp";
import { GithubDeliveryNormalizationError } from "@/server/github-provider-evidence";
import {
  IncidentNotFoundError,
  ProviderEvidenceReadError,
  UnsupportedProviderEvidenceError,
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
    const evidence = await inspectProviderEvidence(incidentId);
    return NextResponse.json({ evidence });
  } catch (error) {
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

    console.error("Unable to inspect provider evidence.", error);
    return NextResponse.json(
      { error: "Unable to inspect provider evidence." },
      { status: 500 },
    );
  }
}
