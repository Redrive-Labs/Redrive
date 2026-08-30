import { timingSafeStringEqual } from "@/domain/github-integration";
import {
  RECEIVER_CAPABILITY_BUSINESS_STATE,
  RECEIVER_CAPABILITY_HEALTH,
  RECEIVER_CONNECTION_READY,
  RECEIVER_CONNECTION_UNHEALTHY,
  RECEIVER_CONNECTION_VERIFYING,
  RECEIVER_CONNECTION_WAITING_FOR_RECEIVER,
  RECEIVER_READ_JOB_EXPIRED,
  RECEIVER_READ_JOB_FAILED,
  RECEIVER_READ_JOB_SUCCEEDED,
  type ReceiverConnection,
  type ReceiverReadJob,
} from "@/domain/receiver-connector";
import { getApplicationConnection } from "@/server/github-connection-service";
import {
  boundedPoll,
  RECEIVER_MCP_WAIT_INTERVAL_MS,
  RECEIVER_MCP_WAIT_MAX_MS,
} from "@/server/receiver-bounded-poll";
import {
  MAX_RECEIVER_REQUEST_BODY_BYTES,
  ReceiverRouteBodyError,
  readReceiverJson,
} from "@/server/receiver-route-utils";
import type { SqliteDatabase } from "@/server/database";

export const RECEIVER_MCP_BUSINESS_STATE_TOOL = "get_business_state" as const;
export const RECEIVER_MCP_HEALTH_TOOL = "get_receiver_health" as const;
export const RECEIVER_MCP_SERVER_NAME = "redrive-receiver" as const;
export const RECEIVER_MCP_SERVER_VERSION = "m2.7a-1b" as const;
export const RECEIVER_MCP_MAX_REQUEST_BYTES = MAX_RECEIVER_REQUEST_BODY_BYTES;
export const RECEIVER_MCP_MAX_RESPONSE_BYTES = 64 * 1024;

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-11-25",
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
  "2024-10-07",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

const BUSINESS_STATE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    connection_id: {
      type: "string",
      description: "Redrive ApplicationConnection identifier.",
    },
    delivery_guid: {
      type: "string",
      description: "Opaque business delivery identity.",
    },
  },
  required: ["connection_id", "delivery_guid"],
  additionalProperties: false,
} as const;

const HEALTH_INPUT_SCHEMA = {
  type: "object",
  properties: {
    connection_id: {
      type: "string",
      description: "Redrive ApplicationConnection identifier.",
    },
  },
  required: ["connection_id"],
  additionalProperties: false,
} as const;

export const RECEIVER_MCP_TOOLS = [
  {
    name: RECEIVER_MCP_BUSINESS_STATE_TOOL,
    description:
      "Read the receiver's typed business state for one GitHub delivery.",
    inputSchema: BUSINESS_STATE_INPUT_SCHEMA,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  {
    name: RECEIVER_MCP_HEALTH_TOOL,
    description: "Read the receiver's typed health state.",
    inputSchema: HEALTH_INPUT_SCHEMA,
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

export interface ReceiverMcpJobService {
  createBusinessStateJob(
    receiverConnectionId: string,
    deliveryGuid: string,
  ): ReceiverReadJob;
  createHealthJob(receiverConnectionId: string): ReceiverReadJob;
  getById(jobId: string): ReceiverReadJob | null;
}

export interface ReceiverMcpConnectionService {
  getByApplicationConnectionId(
    applicationConnectionId: string,
  ): ReceiverConnection | null;
}

export interface ReceiverMcpServices {
  database: SqliteDatabase;
  connections: ReceiverMcpConnectionService;
  jobs: ReceiverMcpJobService;
}

export interface ReceiverMcpWaitOptions {
  maxMs?: number;
  intervalMs?: number;
  clock?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<boolean>;
}

export class ReceiverMcpServerConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverMcpServerConfigurationError";
  }
}

export class ReceiverMcpRequestError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReceiverMcpRequestError";
    this.status = status;
  }
}

class ReceiverMcpToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiverMcpToolError";
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
  const token = suppliedToken ?? environment.REDRIVE_RECEIVER_MCP_TOKEN;
  if (typeof token !== "string" || token.length === 0) {
    throw new ReceiverMcpServerConfigurationError(
      "REDRIVE_RECEIVER_MCP_TOKEN must be configured for the production Receiver MCP.",
    );
  }
  return token;
}

function isAuthorized(request: Request, token: string): boolean {
  const value = request.headers.get("authorization");
  if (value === null || !value.startsWith("Bearer ")) return false;
  const presented = value.slice("Bearer ".length);
  if (presented.length === 0 || /\s/.test(presented)) return false;
  return timingSafeStringEqual(presented, token);
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
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
    new TextEncoder().encode(serialized).byteLength > RECEIVER_MCP_MAX_RESPONSE_BYTES
  ) {
    throw new ReceiverMcpServerConfigurationError(
      "Receiver MCP result could not be serialized.",
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
    { error: "Receiver MCP authentication is required." },
    401,
    { "www-authenticate": "Bearer" },
  );
}

function configurationResponse(): Response {
  return jsonResponse({ error: "Receiver MCP is not configured." }, 503);
}

async function readJsonRequest(request: Request): Promise<unknown> {
  const contentType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (contentType !== "application/json") {
    throw new ReceiverMcpRequestError(
      "Receiver MCP requests must use application/json.",
      415,
    );
  }
  try {
    return await readReceiverJson(request, RECEIVER_MCP_MAX_REQUEST_BYTES);
  } catch (error) {
    if (error instanceof ReceiverRouteBodyError) {
      throw new ReceiverMcpRequestError(error.message, error.status);
    }
    throw new ReceiverMcpRequestError("Receiver MCP request body is invalid.");
  }
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (Array.isArray(value) || !isRecord(value) || value.jsonrpc !== "2.0") {
    throw new ReceiverMcpRequestError("Receiver MCP JSON-RPC request is invalid.");
  }
  if (typeof value.method !== "string" || value.method.length === 0) {
    throw new ReceiverMcpRequestError("Receiver MCP JSON-RPC method is invalid.");
  }
  const id = value.id;
  if (
    id !== undefined &&
    id !== null &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    throw new ReceiverMcpRequestError("Receiver MCP JSON-RPC request ID is invalid.");
  }
  if (typeof id === "number" && !Number.isFinite(id)) {
    throw new ReceiverMcpRequestError("Receiver MCP JSON-RPC request ID is invalid.");
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

function readIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ReceiverMcpRequestError(
      `Receiver MCP ${field} must be a bounded non-empty string.`,
      200,
    );
  }
  return value;
}

function readExactArguments(
  value: unknown,
  expectedKeys: readonly string[],
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new ReceiverMcpRequestError(
      "Receiver MCP tool arguments must be an object.",
      200,
    );
  }
  const expected = new Set(expectedKeys);
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    keys.some((key) => !expected.has(key)) ||
    expectedKeys.some((key) => !hasOwn(value, key))
  ) {
    throw new ReceiverMcpRequestError(
      "Receiver MCP tool arguments contain unexpected or missing fields.",
      200,
    );
  }
  return value;
}

function readBusinessArguments(value: unknown): {
  connectionId: string;
  deliveryGuid: string;
} {
  const args = readExactArguments(value, ["connection_id", "delivery_guid"]);
  return {
    connectionId: readIdentifier(args.connection_id, "connection_id"),
    deliveryGuid: readIdentifier(args.delivery_guid, "delivery_guid"),
  };
}

function readHealthArguments(value: unknown): { connectionId: string } {
  const args = readExactArguments(value, ["connection_id"]);
  return { connectionId: readIdentifier(args.connection_id, "connection_id") };
}

function toolResult(text: string, isError = false): Record<string, unknown> {
  return {
    content: [{ type: "text", text }],
    ...(isError ? { isError: true } : {}),
  };
}

function toolErrorMessage(error: unknown): string {
  if (error instanceof ReceiverMcpRequestError) return error.message;
  if (error instanceof ReceiverMcpToolError) return error.message;
  return "The receiver read could not be completed.";
}

function requireReceiver(
  services: ReceiverMcpServices,
  connectionId: string,
): ReceiverConnection {
  const applicationConnection = getApplicationConnection(
    services.database,
    connectionId,
  );
  if (applicationConnection === null) {
    throw new ReceiverMcpToolError("The application connection was not found.");
  }
  const receiverConnection = services.connections.getByApplicationConnectionId(
    applicationConnection.id,
  );
  if (receiverConnection === null) {
    throw new ReceiverMcpToolError("The receiver connection was not found.");
  }
  return receiverConnection;
}

function requireCapability(
  receiverConnection: ReceiverConnection,
  capability: typeof RECEIVER_CAPABILITY_BUSINESS_STATE | typeof RECEIVER_CAPABILITY_HEALTH,
): void {
  if (!receiverConnection.capabilities?.includes(capability)) {
    throw new ReceiverMcpToolError(
      "The receiver connector does not expose the requested capability.",
    );
  }
}

function requireBusinessStateReady(receiverConnection: ReceiverConnection): void {
  if (receiverConnection.state !== RECEIVER_CONNECTION_READY) {
    throw new ReceiverMcpToolError(
      "Business state is available only when the receiver is READY.",
    );
  }
}

function requireHealthReadable(receiverConnection: ReceiverConnection): void {
  if (
    receiverConnection.state !== RECEIVER_CONNECTION_VERIFYING &&
    receiverConnection.state !== RECEIVER_CONNECTION_READY &&
    receiverConnection.state !== RECEIVER_CONNECTION_UNHEALTHY
  ) {
    if (receiverConnection.state === RECEIVER_CONNECTION_WAITING_FOR_RECEIVER) {
      throw new ReceiverMcpToolError("The receiver connector is not enrolled.");
    }
    throw new ReceiverMcpToolError("Receiver health is not available.");
  }
}

function isTerminal(job: ReceiverReadJob): boolean {
  return (
    job.state === RECEIVER_READ_JOB_SUCCEEDED ||
    job.state === RECEIVER_READ_JOB_FAILED ||
    job.state === RECEIVER_READ_JOB_EXPIRED
  );
}

async function waitForJob(
  services: ReceiverMcpServices,
  jobId: string,
  signal: AbortSignal,
  waitOptions: ReceiverMcpWaitOptions,
): Promise<ReceiverReadJob | null> {
  return boundedPoll({
    deadlineMs: waitOptions.maxMs ?? RECEIVER_MCP_WAIT_MAX_MS,
    intervalMs: waitOptions.intervalMs ?? RECEIVER_MCP_WAIT_INTERVAL_MS,
    clock: waitOptions.clock,
    sleep: waitOptions.sleep,
    signal,
    poll: () => {
      const job = services.jobs.getById(jobId);
      return job !== null && isTerminal(job) ? job : undefined;
    },
  });
}

async function executeBusinessState(
  services: ReceiverMcpServices,
  connectionId: string,
  deliveryGuid: string,
  signal: AbortSignal,
  waitOptions: ReceiverMcpWaitOptions,
): Promise<Record<string, unknown>> {
  const receiverConnection = requireReceiver(services, connectionId);
  requireBusinessStateReady(receiverConnection);
  requireCapability(receiverConnection, RECEIVER_CAPABILITY_BUSINESS_STATE);
  const job = services.jobs.createBusinessStateJob(
    receiverConnection.id,
    deliveryGuid,
  );
  const completed = await waitForJob(services, job.id, signal, waitOptions);
  if (completed === null) {
    throw new ReceiverMcpToolError(
      "The receiver timed out before returning business state.",
    );
  }
  if (completed.state !== RECEIVER_READ_JOB_SUCCEEDED || completed.result === null) {
    throw new ReceiverMcpToolError(
      "The receiver could not return business state before the durable job deadline.",
    );
  }
  return completed.result as unknown as Record<string, unknown>;
}

async function executeHealth(
  services: ReceiverMcpServices,
  connectionId: string,
  signal: AbortSignal,
  waitOptions: ReceiverMcpWaitOptions,
): Promise<Record<string, unknown>> {
  const receiverConnection = requireReceiver(services, connectionId);
  requireHealthReadable(receiverConnection);
  requireCapability(receiverConnection, RECEIVER_CAPABILITY_HEALTH);
  const job = services.jobs.createHealthJob(receiverConnection.id);
  const completed = await waitForJob(services, job.id, signal, waitOptions);
  if (completed === null) {
    throw new ReceiverMcpToolError(
      "The receiver timed out before returning health.",
    );
  }
  if (completed.state !== RECEIVER_READ_JOB_SUCCEEDED || completed.result === null) {
    throw new ReceiverMcpToolError(
      "The receiver could not return health before the durable job deadline.",
    );
  }
  return completed.result as unknown as Record<string, unknown>;
}

async function handleRpcRequest(
  request: JsonRpcRequest,
  getServices: () => ReceiverMcpServices,
  signal: AbortSignal,
  waitOptions: ReceiverMcpWaitOptions,
): Promise<Response> {
  const id = request.id === undefined ? null : request.id;
  const hasId = request.id !== undefined;

  if (request.method === "notifications/initialized") {
    return new Response(null, { status: 202 });
  }
  if (!hasId) {
    return new Response(null, { status: 202 });
  }
  if (request.method === "initialize") {
    return jsonRpcResponse(id, {
      protocolVersion: protocolVersion(request.params),
      capabilities: { tools: { listChanged: false } },
      serverInfo: {
        name: RECEIVER_MCP_SERVER_NAME,
        version: RECEIVER_MCP_SERVER_VERSION,
      },
    });
  }
  if (request.method === "ping") {
    return jsonRpcResponse(id, {});
  }
  if (request.method === "tools/list") {
    return jsonRpcResponse(id, { tools: RECEIVER_MCP_TOOLS });
  }
  if (request.method !== "tools/call") {
    return jsonRpcError(id, -32601, "Receiver MCP method is not available.");
  }
  if (!isRecord(request.params) || typeof request.params.name !== "string") {
    return jsonRpcError(id, -32602, "Receiver MCP tools/call parameters are invalid.");
  }

  try {
    let result: Record<string, unknown>;
    if (request.params.name === RECEIVER_MCP_BUSINESS_STATE_TOOL) {
      const args = readBusinessArguments(request.params.arguments);
      const services = getServices();
      result = await executeBusinessState(
        services,
        args.connectionId,
        args.deliveryGuid,
        signal,
        waitOptions,
      );
    } else if (request.params.name === RECEIVER_MCP_HEALTH_TOOL) {
      const args = readHealthArguments(request.params.arguments);
      const services = getServices();
      result = await executeHealth(services, args.connectionId, signal, waitOptions);
    } else {
      return jsonRpcError(id, -32602, "Receiver MCP tool is not available.");
    }
    const serialized = JSON.stringify(result);
    if (serialized === undefined) {
      throw new ReceiverMcpServerConfigurationError(
        "Receiver MCP result could not be serialized.",
      );
    }
    return boundedJsonRpcResponse(id, toolResult(serialized));
  } catch (error) {
    return jsonRpcResponse(id, toolResult(toolErrorMessage(error), true));
  }
}

export interface ReceiverMcpServer {
  handleRequest(request: Request): Promise<Response>;
}

export function createReceiverMcpServer(options: {
  services?: ReceiverMcpServices;
  getServices?: () => ReceiverMcpServices;
  environment?: NodeJS.ProcessEnv;
  token?: string;
  wait?: ReceiverMcpWaitOptions;
}): ReceiverMcpServer {
  const environment = options.environment ?? process.env;
  const getServices = options.getServices ?? (() => {
    if (options.services === undefined) {
      throw new ReceiverMcpServerConfigurationError(
        "Receiver MCP services are not configured.",
      );
    }
    return options.services;
  });

  return {
    async handleRequest(request) {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "Receiver MCP accepts POST requests only." },
          405,
          { allow: "POST" },
        );
      }

      let token: string;
      try {
        token = readConfiguredToken(environment, options.token);
      } catch {
        return configurationResponse();
      }

      // Authentication must precede request-body parsing and service creation.
      if (!isAuthorized(request, token)) return unauthorizedResponse();

      let value: unknown;
      try {
        value = await readJsonRequest(request);
      } catch (error) {
        if (error instanceof ReceiverMcpRequestError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "Receiver MCP request is invalid." }, 400);
      }

      let rpcRequest: JsonRpcRequest;
      try {
        rpcRequest = parseJsonRpcRequest(value);
      } catch (error) {
        if (error instanceof ReceiverMcpRequestError) {
          return jsonResponse({ error: error.message }, error.status);
        }
        return jsonResponse({ error: "Receiver MCP JSON-RPC request is invalid." }, 400);
      }

      try {
        return await handleRpcRequest(
          rpcRequest,
          getServices,
          request.signal,
          options.wait ?? {},
        );
      } catch {
        if (rpcRequest.id === undefined) return new Response(null, { status: 202 });
        return jsonRpcResponse(
          rpcRequest.id,
          toolResult("The Receiver MCP request could not be completed.", true),
        );
      }
    },
  };
}
