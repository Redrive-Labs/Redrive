import { timingSafeStringEqual } from "@/domain/github-integration";
import { GithubConnectionError } from "@/server/github-connection-service";

export const GITHUB_WEBHOOK_DELIVERY_TOOL = "get_webhook_delivery" as const;
export const GITHUB_MCP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/**
 * The production provider boundary is intentionally stateless. TrueForge's
 * Streamable HTTP client initializes, sends tools/list, and then sends each
 * tools/call as an independent JSON request. Credentials and connection
 * resolution stay on the Redrive side of this boundary.
 */
export const GITHUB_MCP_SERVER_NAME = "redrive-github" as const;
export const GITHUB_MCP_SERVER_VERSION = "m2.6b" as const;
export const GITHUB_MCP_MAX_REQUEST_BYTES = 64 * 1024;

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    connection_id: {
      type: "string",
      description: "Redrive ApplicationConnection identifier.",
    },
    delivery_id: {
      type: "string",
      description: "Opaque GitHub webhook delivery attempt identifier.",
    },
  },
  required: ["connection_id", "delivery_id"],
  additionalProperties: false,
} as const;

const TOOLS = [
  {
    name: GITHUB_WEBHOOK_DELIVERY_TOOL,
    description:
      "Read one failed GitHub webhook delivery through its Redrive ApplicationConnection.",
    inputSchema: TOOL_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
] as const;

type JsonRpcId = string | number | null;

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface GithubMcpDeliveryService {
  getFullFailedDelivery(
    connectionId: string,
    deliveryId: string,
  ): Promise<unknown>;
}

export class GithubMcpServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubMcpServerConfigurationError";
  }
}

export class GithubMcpRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "GithubMcpRequestError";
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function readConfiguredToken(
  environment: NodeJS.ProcessEnv,
  suppliedToken?: string,
): string {
  // Keep the M2.6B credential separate from the legacy bridge credential.
  // There is deliberately no fallback: a legacy credential must not authorize
  // reads through this connection-bound production endpoint.
  const token =
    suppliedToken ?? environment.REDRIVE_GITHUB_CONNECTION_MCP_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new GithubMcpServerConfigurationError(
      "REDRIVE_GITHUB_CONNECTION_MCP_TOKEN must be configured for the production GitHub MCP.",
    );
  }
  return token;
}

function isAuthorized(request: Request, token: string): boolean {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return false;
  const presented = value.slice("Bearer ".length);
  if (presented.length === 0 || /[\s]/.test(presented)) return false;
  return timingSafeStringEqual(presented, token);
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function jsonRpcResponse(id: JsonRpcId, result: unknown): Response {
  return jsonResponse({ jsonrpc: "2.0", id, result });
}

function boundedJsonRpcResponse(id: JsonRpcId, result: unknown): Response {
  const payload = { jsonrpc: "2.0", id, result };
  const serialized = JSON.stringify(payload);
  if (
    serialized === undefined ||
    new TextEncoder().encode(serialized).byteLength > GITHUB_MCP_MAX_RESPONSE_BYTES
  ) {
    throw new GithubMcpServerConfigurationError(
      "GitHub delivery result could not be serialized.",
    );
  }
  return jsonResponse(payload);
}

function jsonRpcError(
  id: JsonRpcId,
  code: number,
  message: string,
): Response {
  return jsonResponse({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });
}

function unauthorizedResponse(): Response {
  return jsonResponse(
    { error: "GitHub MCP authentication is required." },
    401,
    { "www-authenticate": "Bearer" },
  );
}

function configurationResponse(): Response {
  return jsonResponse(
    { error: "GitHub MCP is not configured." },
    503,
  );
}

async function readJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GithubMcpRequestError(
      "GitHub MCP requests must use application/json.",
      415,
    );
  }

  // Request.text() does not provide a byte bound, so decode bounded chunks
  // directly from the request stream and preserve fatal UTF-8 behavior.
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const normalized = contentLength.trim();
    const maximum = String(GITHUB_MCP_MAX_REQUEST_BYTES);
    if (
      !/^\d+$/.test(normalized) ||
      normalized.length > maximum.length ||
      (normalized.length === maximum.length && normalized > maximum)
    ) {
      throw new GithubMcpRequestError("GitHub MCP request body is too large.", 413);
    }
  }

  let text: string;
  if (request.body === null) {
    text = "";
  } else {
    const reader = request.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0;
    text = "";
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          text += decoder.decode();
          break;
        }
        bytes += chunk.value.byteLength;
        if (bytes > GITHUB_MCP_MAX_REQUEST_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // Keep the bounded size error.
          }
          throw new GithubMcpRequestError("GitHub MCP request body is too large.", 413);
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
    } catch (error) {
      if (error instanceof GithubMcpRequestError) throw error;
      throw new GithubMcpRequestError("GitHub MCP request body is invalid.", 400);
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // A cancelled stream may already own the lock.
      }
    }
  }

  if (text.trim().length === 0) {
    throw new GithubMcpRequestError("GitHub MCP request body is required.", 400);
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GithubMcpRequestError("GitHub MCP request body is invalid JSON.", 400);
  }
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (Array.isArray(value) || !isRecord(value) || value.jsonrpc !== "2.0") {
    throw new GithubMcpRequestError("GitHub MCP JSON-RPC request is invalid.", 400);
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    throw new GithubMcpRequestError("GitHub MCP JSON-RPC method is invalid.", 400);
  }

  const id = value.id;
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    throw new GithubMcpRequestError("GitHub MCP JSON-RPC request ID is invalid.", 400);
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new GithubMcpRequestError("GitHub MCP JSON-RPC request ID is invalid.", 400);
  }

  return {
    jsonrpc: "2.0",
    ...(id === undefined ? {} : { id }),
    method: value.method,
    ...(hasOwn(value, "params") ? { params: value.params } : {}),
  };
}

function protocolVersion(params: unknown): string {
  if (isRecord(params) && typeof params.protocolVersion === "string") {
    return SUPPORTED_PROTOCOL_VERSIONS.has(params.protocolVersion)
      ? params.protocolVersion
      : DEFAULT_PROTOCOL_VERSION;
  }
  return DEFAULT_PROTOCOL_VERSION;
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof GithubConnectionError) {
    switch (error.code) {
      case "INVALID_INPUT":
        return "The GitHub MCP lookup identifiers are invalid.";
      case "NOT_FOUND":
        return "The requested GitHub connection or delivery was not found.";
      case "NOT_ACCESSIBLE":
        return "The requested GitHub connection or delivery is not accessible.";
      case "REMOTE_INVALID":
        return "GitHub returned an invalid or mismatched connection result.";
      case "RECOVERY_REQUIRED":
        return "The GitHub connection requires credential recovery.";
    }
  }
  return "The GitHub webhook delivery could not be read.";
}

function readToolArguments(value: unknown): {
  connectionId: string;
  deliveryId: string;
} {
  if (!isRecord(value)) {
    throw new GithubMcpRequestError("GitHub MCP tool arguments must be an object.", 200);
  }
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "connection_id" || keys[1] !== "delivery_id") {
    throw new GithubMcpRequestError(
      "GitHub MCP tool arguments contain unexpected fields.",
      200,
    );
  }
  const connectionId = value.connection_id;
  const deliveryId = value.delivery_id;
  if (
    typeof connectionId !== "string" ||
    connectionId.length === 0 ||
    connectionId.length > 1024 ||
    typeof deliveryId !== "string" ||
    deliveryId.length === 0 ||
    deliveryId.length > 1024
  ) {
    throw new GithubMcpRequestError(
      "GitHub MCP tool arguments must contain non-empty string identifiers.",
      200,
    );
  }
  return { connectionId, deliveryId };
}

function toolResult(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleRpcRequest(
  request: JsonRpcRequest,
  getDeliveryService: () => GithubMcpDeliveryService,
): Promise<Response> {
  const id = request.id === undefined ? null : request.id;
  const hasId = request.id !== undefined;

  if (request.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }

  if (!hasId) {
    // Notifications never produce a response and must not execute a provider
    // lookup whose result could not be attributed to a caller.
    return new Response(null, { status: 202 });
  }

  if (request.method === "initialize") {
    return jsonRpcResponse(id, {
      protocolVersion: protocolVersion(request.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: GITHUB_MCP_SERVER_NAME,
        version: GITHUB_MCP_SERVER_VERSION,
      },
    });
  }

  if (request.method === "ping") {
    return jsonRpcResponse(id, {});
  }

  if (request.method === "tools/list") {
    return jsonRpcResponse(id, { tools: TOOLS });
  }

  if (request.method === "tools/call") {
    if (!isRecord(request.params) || typeof request.params.name !== "string") {
      return jsonRpcError(id, -32602, "GitHub MCP tools/call parameters are invalid.");
    }
    if (request.params.name !== GITHUB_WEBHOOK_DELIVERY_TOOL) {
      return jsonRpcError(id, -32602, "GitHub MCP tool is not available.");
    }

    try {
      const args = readToolArguments(request.params.arguments);
      const delivery = await getDeliveryService().getFullFailedDelivery(
        args.connectionId,
        args.deliveryId,
      );
      if (delivery === undefined) {
        throw new GithubMcpServerConfigurationError(
          "GitHub delivery result could not be serialized.",
        );
      }
      const body = JSON.stringify({
        full: {
          http_status: 200,
          body: delivery,
        },
      });
      if (
        body === undefined ||
        new TextEncoder().encode(body).byteLength > GITHUB_MCP_MAX_RESPONSE_BYTES
      ) {
        throw new GithubMcpServerConfigurationError(
          "GitHub delivery result could not be serialized.",
        );
      }
      return boundedJsonRpcResponse(id, toolResult(body));
    } catch (error) {
      const message =
        error instanceof GithubMcpRequestError ||
        error instanceof GithubMcpServerConfigurationError
          ? error.message
          : toolErrorMessage(error);
      return jsonRpcResponse(id, toolResult(message, true));
    }
  }

  return jsonRpcError(id, -32601, "GitHub MCP method is not available.");
}

export interface GithubMcpServer {
  handleRequest(request: Request): Promise<Response>;
}

export function createGithubMcpServer(options: {
  deliveryService?: GithubMcpDeliveryService;
  getDeliveryService?: () => GithubMcpDeliveryService;
  environment?: NodeJS.ProcessEnv;
  token?: string;
}): GithubMcpServer {
  const environment = options.environment ?? process.env;
  const getDeliveryService = options.getDeliveryService ?? (() => {
    if (options.deliveryService === undefined) {
      throw new GithubMcpServerConfigurationError(
        "GitHub MCP delivery service is not configured.",
      );
    }
    return options.deliveryService;
  });

  return {
    async handleRequest(request) {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "GitHub MCP accepts POST requests only." },
          405,
          { allow: "POST" },
        );
      }

      let token: string;
      try {
        token = readConfiguredToken(environment, options.token);
      } catch (error) {
        if (error instanceof GithubMcpServerConfigurationError) {
          return configurationResponse();
        }
        return configurationResponse();
      }

      // Authenticate before reading/parsing the request and before any service
      // method can execute. No failed request includes the configured token.
      if (!isAuthorized(request, token)) {
        return unauthorizedResponse();
      }

      let value: unknown;
      try {
        value = await readJsonRequest(request);
      } catch (error) {
        if (error instanceof GithubMcpRequestError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "GitHub MCP request is invalid." }, 400);
      }

      let rpcRequest: JsonRpcRequest;
      try {
        rpcRequest = parseJsonRpcRequest(value);
      } catch (error) {
        if (error instanceof GithubMcpRequestError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "GitHub MCP JSON-RPC request is invalid." }, 400);
      }

      try {
        return await handleRpcRequest(rpcRequest, getDeliveryService);
      } catch {
        // Never serialize an upstream error, request body, or credential into
        // the protocol response.
        if (rpcRequest.id === undefined) return new Response(null, { status: 202 });
        return jsonRpcResponse(
          rpcRequest.id,
          toolResult("The GitHub MCP request could not be completed.", true),
        );
      }
    },
  };
}

