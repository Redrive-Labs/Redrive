import { NextResponse } from "next/server";
import { getServerConfig } from "@/server/config";
import { getConfiguredDatabase } from "@/server/database";
import { createReceiverConnectorAuthService } from "@/server/receiver-connection-service";
import { createReceiverReadJobTransportService } from "@/server/receiver-read-job-service";
import {
  boundedPoll,
  RECEIVER_CONNECTOR_LONG_POLL_INTERVAL_MS,
  RECEIVER_CONNECTOR_LONG_POLL_MAX_MS,
} from "@/server/receiver-bounded-poll";
import {
  readReceiverConnectorCredentials,
  receiverErrorResponse,
  toReceiverLeasedJob,
} from "@/server/receiver-route-utils";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  try {
    const config = getServerConfig();
    const database = getConfiguredDatabase(config.databasePath);
    const credentials = readReceiverConnectorCredentials(request);
    const connectionService = createReceiverConnectorAuthService({ database });
    // Authentication is completed before any queue selection or wait begins.
    const authentication = connectionService.authenticate(credentials);
    const jobs = createReceiverReadJobTransportService({ database });
    const job = await boundedPoll({
      deadlineMs: RECEIVER_CONNECTOR_LONG_POLL_MAX_MS,
      intervalMs: RECEIVER_CONNECTOR_LONG_POLL_INTERVAL_MS,
      signal: request.signal,
      poll: () => jobs.leaseNext(authentication) ?? undefined,
    });

    return NextResponse.json(
      {
        job: job === null ? null : toReceiverLeasedJob(job),
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return receiverErrorResponse(error, "Receiver job lease could not be completed.");
  }
}

export async function GET(): Promise<Response> {
  return NextResponse.json(
    { error: "Receiver job lease accepts POST requests only." },
    { status: 405, headers: { allow: "POST" } },
  );
}
