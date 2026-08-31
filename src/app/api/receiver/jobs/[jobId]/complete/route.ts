import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import { createReceiverConnectorAuthService } from "@/server/receiver/receiver-connection-service";
import { createReceiverReadJobTransportService } from "@/server/receiver/receiver-read-job-service";
import {
  parseReceiverCompletionRequest,
  readReceiverConnectorCredentials,
  readReceiverJson,
  receiverErrorResponse,
  toReceiverCompletedJob,
} from "@/server/receiver/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(
  request: Request,
  context: { params: Promise<{ jobId: string }> },
): Promise<Response> {
  try {
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const credentials = readReceiverConnectorCredentials(request);
    const connectionService = createReceiverConnectorAuthService({ database });
    // Do not read the body or touch the job until the connector principal is
    // authenticated by the 1a service.
    const authentication = connectionService.authenticate(credentials);
    const body = await readReceiverJson(request);
    const completion = parseReceiverCompletionRequest(body);
    const { jobId } = await context.params;
    const jobs = createReceiverReadJobTransportService({ database });
    const job =
      completion.outcome === "SUCCEEDED"
        ? jobs.complete(
            jobId,
            authentication,
            completion.leaseGeneration,
            completion.result,
          )
        : jobs.fail(
            jobId,
            authentication,
            completion.leaseGeneration,
            completion.errorCode,
          );

    return NextResponse.json(
      { job: toReceiverCompletedJob(job) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return receiverErrorResponse(
      error,
      "Receiver job completion could not be recorded.",
    );
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "Receiver job completion accepts POST requests only." },
    { status: 405, headers: { allow: "POST" } },
  );
}
