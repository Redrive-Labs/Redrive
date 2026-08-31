import { NextResponse } from "next/server";
import {
  DeploymentAlreadyAttemptedError,
  DeploymentCommandFailure,
  DeploymentConfigurationError,
  DeploymentExecutionError,
  DeploymentFingerprintMismatchError,
  DeploymentNotEligibleError,
  DeploymentNotFoundError,
  DeploymentOutcomeUnknownError,
  DeploymentPermitError,
  DeploymentPreconditionError,
  DeploymentReconciliationRequiredError,
  DeploymentVerificationError,
  deployRecovery,
  getDeploymentStatusForIncident,
} from "@/server/recovery/recovery-deployment-service";
import {
  readReceiverJson,
  ReceiverRouteBodyError,
  requireOperatorSession,
} from "@/server/receiver/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

class DeploymentRequestBodyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentRequestBodyError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readPermitRequest(value: unknown): string {
  if (!isRecord(value) || Object.keys(value).length !== 1 || !("permitId" in value)) {
    throw new DeploymentRequestBodyError(
      "Deployment request must contain only permitId.",
    );
  }
  if (
    typeof value.permitId !== "string" ||
    value.permitId.trim().length === 0 ||
    value.permitId.length > 1024
  ) {
    throw new DeploymentRequestBodyError("Deployment permitId is invalid.");
  }
  return value.permitId;
}

function deploymentResponse(body: unknown, status = 200): Response {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const { incidentId } = await context.params;
    return deploymentResponse(getDeploymentStatusForIncident(incidentId));
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ incidentId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const body = await readReceiverJson(request);
    const permitId = readPermitRequest(body);
    const { incidentId } = await context.params;
    return deploymentResponse(await deployRecovery(incidentId, permitId));
  } catch (error) {
    return deploymentErrorResponse(error);
  }
}

export function deploymentErrorResponse(error: unknown): Response {
  if (error instanceof ReceiverRouteBodyError || error instanceof DeploymentRequestBodyError) {
    return deploymentResponse({ error: error.message }, 400);
  }
  if (error instanceof DeploymentNotFoundError) {
    return deploymentResponse({ error: error.message }, 404);
  }
  if (error instanceof DeploymentConfigurationError) {
    return deploymentResponse({ error: error.message }, 503);
  }
  if (error instanceof DeploymentFingerprintMismatchError || error instanceof DeploymentPermitError) {
    return deploymentResponse({ error: error.message }, 409);
  }
  if (error instanceof DeploymentNotEligibleError || error instanceof DeploymentPreconditionError) {
    return deploymentResponse({ error: error.message }, 422);
  }
  if (error instanceof DeploymentReconciliationRequiredError || error instanceof DeploymentAlreadyAttemptedError) {
    return deploymentResponse(
      { error: error.message, deployment: error.deployment },
      409,
    );
  }
  if (error instanceof DeploymentVerificationError || error instanceof DeploymentExecutionError) {
    return deploymentResponse(
      { error: error.message, deployment: error.deployment },
      422,
    );
  }
  if (error instanceof DeploymentOutcomeUnknownError) {
    return deploymentResponse(
      { error: error.message, blocked: true, deployment: error.deployment },
      503,
    );
  }
  if (error instanceof DeploymentCommandFailure) {
    return deploymentResponse({ error: "Deployment command execution failed." }, 502);
  }
  console.error("Unable to deploy the verified recovery repair.", error);
  return deploymentResponse({ error: "Unable to deploy the verified recovery repair." }, 500);
}
