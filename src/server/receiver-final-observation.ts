import {
  parseBusinessStateReadResult,
  type BusinessStateReadResult,
} from "@/domain/receiver-connector";
import type { SqliteDatabase } from "@/server/database";
import {
  createReceiverConnectionService,
} from "@/server/receiver-connection-service";
import {
  createReceiverReadJobTransportService,
} from "@/server/receiver-read-job-service";
import {
  createReceiverMcpServer,
  type ReceiverMcpWaitOptions,
} from "@/server/receiver-mcp-server";

export interface ReceiverBusinessStateReader {
  readBusinessState(
    applicationConnectionId: string,
    deliveryGuid: string,
  ): Promise<BusinessStateReadResult>;
}

export class ReceiverFinalObservationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverFinalObservationError";
  }
}

interface ReceiverMcpResult {
  result?: {
    content?: Array<{ type?: unknown; text?: unknown }>;
  };
}

function readMcpResult(value: unknown): string {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiverFinalObservationError(
      "The receiver returned an invalid read response.",
    );
  }
  const response = value as ReceiverMcpResult;
  const content = response.result?.content;
  if (
    !Array.isArray(content) ||
    content.length !== 1 ||
    content[0]?.type !== "text" ||
    typeof content[0].text !== "string"
  ) {
    throw new ReceiverFinalObservationError(
      "The receiver returned an invalid business-state response.",
    );
  }
  return content[0].text;
}

/**
 * Deterministic fallback for final observations. It uses the existing typed
 * Receiver MCP capability and durable read-job transport; it does not issue
 * arbitrary SQL or re-run the TrueForge provider/receiver investigation.
 */
export function createTypedReceiverBusinessStateReader(options: {
  database: SqliteDatabase;
  environment?: NodeJS.ProcessEnv;
  wait?: ReceiverMcpWaitOptions;
}): ReceiverBusinessStateReader {
  const environment = options.environment ?? process.env;
  const server = createReceiverMcpServer({
    getServices: () => ({
      database: options.database,
      connections: createReceiverConnectionService({ database: options.database }),
      jobs: createReceiverReadJobTransportService({ database: options.database }),
    }),
    environment,
    wait: options.wait,
  });

  return {
    async readBusinessState(
      applicationConnectionId: string,
      deliveryGuid: string,
    ): Promise<BusinessStateReadResult> {
      const token = environment.REDRIVE_RECEIVER_MCP_TOKEN?.trim();
      if (!token) {
        throw new ReceiverFinalObservationError(
          "The typed receiver business-state capability is not configured.",
        );
      }

      let response: Response;
      try {
        response = await server.handleRequest(
          new Request("http://redrive.internal/api/mcp/receiver", {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: "redrive-final-observation",
              method: "tools/call",
              params: {
                name: "get_business_state",
                arguments: {
                  connection_id: applicationConnectionId,
                  delivery_guid: deliveryGuid,
                },
              },
            }),
          }),
        );
      } catch {
        throw new ReceiverFinalObservationError(
          "The typed receiver business-state capability could not be called.",
        );
      }

      if (!response.ok) {
        throw new ReceiverFinalObservationError(
          "The typed receiver business-state capability did not complete.",
        );
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        throw new ReceiverFinalObservationError(
          "The typed receiver business-state response was not valid JSON.",
        );
      }

      try {
        return parseBusinessStateReadResult(
          JSON.parse(readMcpResult(body)) as unknown,
          deliveryGuid,
        );
      } catch (error) {
        if (error instanceof ReceiverFinalObservationError) throw error;
        throw new ReceiverFinalObservationError(
          "The typed receiver business-state result was invalid.",
        );
      }
    },
  };
}
