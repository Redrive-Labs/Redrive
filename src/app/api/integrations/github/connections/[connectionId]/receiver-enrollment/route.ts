import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createReceiverEnrollmentService } from "@/server/receiver-connection-service";
import {
  parseReceiverEnrollmentAction,
  readReceiverJson,
  receiverErrorResponse,
  requireOperatorSession,
  toSafeReceiverConnection,
} from "@/server/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ connectionId: string }> },
): Promise<Response> {
  const unauthorized = requireOperatorSession(request);
  if (unauthorized !== null) return unauthorized;

  try {
    const body = await readReceiverJson(request);
    const action = parseReceiverEnrollmentAction(body);
    const { connectionId } = await context.params;
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const service = createReceiverEnrollmentService({ database });
    const issuance =
      action === "ISSUE"
        ? service.issue(connectionId)
        : service.reissue(connectionId);

    return NextResponse.json(
      {
        receiverConnection: toSafeReceiverConnection(issuance.receiverConnection),
        enrollmentToken: issuance.enrollmentToken,
        enrollmentExpiresAt: issuance.enrollmentExpiresAt,
      },
      {
        status: action === "ISSUE" ? 201 : 200,
        headers: { "cache-control": "no-store" },
      },
    );
  } catch (error) {
    return receiverErrorResponse(
      error,
      "Receiver enrollment could not be issued.",
    );
  }
}
