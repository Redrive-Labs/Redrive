import { NextResponse } from "next/server";
import { RecoveryCoordinatorConfigurationError } from "@/agents/recovery-coordinator";
import { GithubMcpConfigurationError } from "@/server/github-mcp";
import {
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
  UnsupportedProviderEvidenceError,
} from "@/server/provider-evidence-service";
import {
  investigateProviderForIncident,
  ProviderInvestigationConfigurationError,
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
} from "@/server/provider-investigation-service";
import {
  TrueForgeSessionBindingError,
  TrueForgeSessionSpecUpgradeError,
  TrueForgeSessionUnavailableError,
  TrueForgeUnsupportedCoordinatorSpecError,
} from "@/server/trueforge-session-service";
import {
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
  TrueForgeTurnCreateError,
} from "@/server/trueforge-client";
import { GithubDeliveryNormalizationError } from "@/server/github-provider-evidence";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface ProviderInvestigationRouteContext {
  params: Promise<{ incidentId: string }>;
}

export async function POST(
  _request: Request,
  context: ProviderInvestigationRouteContext,
): Promise<Response> {
  const { incidentId } = await context.params;

  try {
    return NextResponse.json(await investigateProviderForIncident(incidentId));
  } catch (error) {
    return providerInvestigationErrorResponse(error);
  }
}

function providerInvestigationErrorResponse(error: unknown): Response {
  if (error instanceof IncidentNotFoundError) {
    return NextResponse.json({ error: "Incident not found." }, { status: 404 });
  }

  if (error instanceof UnsupportedProviderEvidenceError) {
    return NextResponse.json(
      { error: "Provider investigation is not supported for this incident." },
      { status: 422 },
    );
  }

  if (
    error instanceof RecoveryCoordinatorConfigurationError ||
    error instanceof TrueForgeConfigurationError ||
    error instanceof GithubMcpConfigurationError ||
    error instanceof ProviderInvestigationConfigurationError
  ) {
    return NextResponse.json(
      { error: "Provider investigation is not configured." },
      { status: 503 },
    );
  }

  if (
    error instanceof TrueForgeSessionUnavailableError ||
    error instanceof TrueForgeSessionSpecUpgradeError ||
    error instanceof TrueForgeUnsupportedCoordinatorSpecError
  ) {
    return NextResponse.json(
      { error: "The TrueForge session is not ready for provider investigation." },
      { status: 503 },
    );
  }

  if (error instanceof ProviderEvidenceConflictError) {
    return NextResponse.json(
      { error: "The provider observation conflicts with immutable evidence." },
      { status: 409 },
    );
  }

  if (
    error instanceof ProviderInvestigationEvidenceError ||
    error instanceof GithubDeliveryNormalizationError
  ) {
    return NextResponse.json(
      { error: "TrueForge provider evidence was malformed or mismatched." },
      { status: 422 },
    );
  }

  if (error instanceof ProviderInvestigationTurnError) {
    return NextResponse.json(
      { error: "TrueForge provider investigation did not produce valid evidence." },
      { status: 502 },
    );
  }

  if (error instanceof TrueForgeSessionCreateError) {
    return NextResponse.json(
      { error: "The TrueForge Coordinator session could not be created." },
      { status: 502 },
    );
  }

  if (error instanceof TrueForgeTurnCreateError) {
    return NextResponse.json(
      { error: "TrueForge provider investigation could not be started." },
      { status: 502 },
    );
  }

  if (error instanceof TrueForgeSessionBindingError) {
    return NextResponse.json(
      { error: "The TrueForge session binding could not be read or updated." },
      { status: 503 },
    );
  }

  console.error("Unable to investigate provider delivery.", error);
  return NextResponse.json(
    { error: "Unable to investigate provider delivery." },
    { status: 500 },
  );
}
