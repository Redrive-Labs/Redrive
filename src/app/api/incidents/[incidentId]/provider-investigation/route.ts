import { NextResponse } from "next/server";
import { RecoveryCoordinatorConfigurationError } from "@/agents/recovery-coordinator";
import {
  IncidentNotFoundError,
  ProviderEvidenceConflictError,
  UnsupportedProviderEvidenceError,
} from "@/server/incidents/provider-evidence-service";
import {
  IncidentInvestigationInProgressError,
  IncidentInvestigationRetryableError,
  investigateIncidentForRecovery,
} from "@/server/incidents/incident-investigation-service";
import {
  ProviderInvestigationConfigurationError,
  ProviderInvestigationEvidenceError,
  ProviderInvestigationTurnError,
} from "@/server/incidents/provider-investigation-service";
import {
  ReceiverInvestigationConfigurationError,
  ReceiverInvestigationEvidenceError,
  ReceiverInvestigationTurnError,
} from "@/server/receiver/receiver-investigation-service";
import {
  ReceiverObservationProvenanceConflictError,
  ReceiverObservationSessionBindingError,
} from "@/server/receiver/receiver-observation-service";
import {
  TrueForgeSessionBindingError,
  TrueForgeSessionSpecUpgradeError,
  TrueForgeSessionUnavailableError,
  TrueForgeSessionMismatchError,
  TrueForgeUnsupportedCoordinatorSpecError,
} from "@/server/trueforge/trueforge-session-service";
import {
  TrueForgeConfigurationError,
  TrueForgeSessionCreateError,
  TrueForgeTurnCreateError,
} from "@/server/trueforge/trueforge-client";
import { GithubDeliveryNormalizationError } from "@/server/github/github-provider-evidence";

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
    return NextResponse.json(await investigateIncidentForRecovery(incidentId));
  } catch (error) {
    return providerInvestigationErrorResponse(error);
  }
}

function providerInvestigationErrorResponse(error: unknown): Response {
  if (error instanceof IncidentInvestigationInProgressError) {
    return NextResponse.json(
      { error: "Investigation is already running or awaiting TrueForge reconciliation. Refresh shortly to reuse its persisted result." },
      { status: 409 },
    );
  }

  if (error instanceof IncidentInvestigationRetryableError) {
    return NextResponse.json(
      { error: "TrueForge did not retain the reserved turn. Retry to start a new serialized investigation attempt." },
      { status: 503 },
    );
  }
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
    error instanceof ProviderInvestigationConfigurationError ||
    error instanceof ReceiverInvestigationConfigurationError
  ) {
    return NextResponse.json(
      { error: "Provider investigation is not configured." },
      { status: 503 },
    );
  }

  if (
    error instanceof TrueForgeSessionUnavailableError ||
    error instanceof TrueForgeSessionMismatchError ||
    error instanceof TrueForgeSessionSpecUpgradeError ||
    error instanceof TrueForgeUnsupportedCoordinatorSpecError
  ) {
    return NextResponse.json(
      { error: "The TrueForge session is not ready for provider investigation." },
      { status: 503 },
    );
  }

  if (error instanceof ReceiverObservationSessionBindingError) {
    return NextResponse.json(
      { error: "The receiver evidence session binding is not ready." },
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

  if (error instanceof ReceiverInvestigationEvidenceError) {
    return NextResponse.json(
      { error: "TrueForge receiver evidence was malformed or mismatched." },
      { status: 422 },
    );
  }

  if (
    error instanceof ProviderInvestigationTurnError ||
    error instanceof ReceiverInvestigationTurnError
  ) {
    return NextResponse.json(
      { error: "TrueForge investigation did not produce valid evidence." },
      { status: 502 },
    );
  }

  if (error instanceof ReceiverObservationProvenanceConflictError) {
    return NextResponse.json(
      { error: "The receiver observation conflicts with immutable provenance." },
      { status: 409 },
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
      { error: "TrueForge investigation could not be started." },
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
