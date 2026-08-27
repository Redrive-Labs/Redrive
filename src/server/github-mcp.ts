import { randomUUID } from "node:crypto";

export const GITHUB_WEBHOOK_DELIVERY_TOOL = "get_webhook_delivery" as const;
export const GITHUB_MCP_TIMEOUT_MS = 12_000;
// GitHub caps webhook payloads at 25 MB. The proven bridge wraps the tool's
// JSON text inside a JSON-RPC envelope, which can nearly double its byte size.
export const GITHUB_MCP_MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
export const MAX_JSON_NUMERIC_LITERAL_CHARS = 4096;

export interface GithubWebhookDeliveryLookup {
  repositoryId: string;
  deliveryId: string;
}

export interface GithubWebhookDeliveryReader {
  getWebhookDelivery(lookup: GithubWebhookDeliveryLookup): Promise<unknown>;
}

export type GithubMcpToolCaller = (
  toolName: typeof GITHUB_WEBHOOK_DELIVERY_TOOL,
  input: {
    hook_id: string;
    delivery_id: string;
  },
) => Promise<unknown>;

export type GithubHookIdResolver = (repositoryId: string) => string;

export class GithubMcpError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "GithubMcpError";
  }
}

export class GithubMcpTimeoutError extends GithubMcpError {
  constructor() {
    super("GitHub MCP request timed out.");
    this.name = "GithubMcpTimeoutError";
  }
}

export class GithubMcpResponseTooLargeError extends GithubMcpError {
  constructor() {
    super("GitHub MCP response is too large.");
    this.name = "GithubMcpResponseTooLargeError";
  }
}

export class GithubMcpConfigurationError extends GithubMcpError {
  constructor(message: string) {
    super(message);
    this.name = "GithubMcpConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const JSON_NUMBER_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/;
const MAX_NORMALIZED_DECIMAL_EXPONENT = MAX_JSON_NUMERIC_LITERAL_CHARS * 2;
const MAX_SAFE_INTEGER_DECIMAL = String(Number.MAX_SAFE_INTEGER);

type NormalizedDecimal =
  | { kind: "zero" }
  | {
      kind: "nonzero";
      sign: 1 | -1;
      coefficient: string;
      exponent: number;
    };

function addBoundedDecimalExponent(left: number, right: number): number {
  return Math.max(
    -MAX_NORMALIZED_DECIMAL_EXPONENT,
    Math.min(MAX_NORMALIZED_DECIMAL_EXPONENT, left + right),
  );
}

/**
 * Parse an exponent without converting an attacker-controlled decimal string
 * to BigInt. Values beyond the bound cannot equal the exponent emitted for a
 * finite JavaScript Number, even after the bounded mantissa adjustment.
 */
function parseBoundedDecimalExponent(text: string): number {
  let sign = 1;
  let start = 0;
  if (text[0] === "-" || text[0] === "+") {
    sign = text[0] === "-" ? -1 : 1;
    start = 1;
  }

  let magnitude = 0;
  for (let index = start; index < text.length; index += 1) {
    const digit = text.charCodeAt(index) - 48;
    if (
      magnitude >
      Math.floor((MAX_NORMALIZED_DECIMAL_EXPONENT - digit) / 10)
    ) {
      return sign * MAX_NORMALIZED_DECIMAL_EXPONENT;
    }
    magnitude = magnitude * 10 + digit;
  }

  return magnitude === 0 ? 0 : sign * magnitude;
}

function normalizeDecimalLiteral(literal: string): NormalizedDecimal {
  const match = literal.match(
    /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/,
  );
  if (match === null) {
    throw new GithubMcpError("GitHub MCP returned invalid JSON.");
  }

  const [, signText, whole, fraction = "", exponentText = "0"] = match;
  let digits = `${whole}${fraction}`;
  const firstNonzero = digits.search(/[1-9]/);
  if (firstNonzero === -1) {
    return { kind: "zero" };
  }

  digits = digits.slice(firstNonzero);
  const coefficient = digits.replace(/0+$/, "");
  const trailingZeroCount = digits.length - coefficient.length;
  let exponent = parseBoundedDecimalExponent(exponentText);
  exponent = addBoundedDecimalExponent(exponent, -fraction.length);
  exponent = addBoundedDecimalExponent(exponent, trailingZeroCount);

  return {
    kind: "nonzero",
    sign: signText === "-" ? -1 : 1,
    coefficient,
    exponent,
  };
}

function decimalValuesAreEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimalLiteral(left);
  const normalizedRight = normalizeDecimalLiteral(right);

  if (normalizedLeft.kind === "zero" || normalizedRight.kind === "zero") {
    return normalizedLeft.kind === "zero" && normalizedRight.kind === "zero";
  }

  return (
    normalizedLeft.sign === normalizedRight.sign &&
    normalizedLeft.coefficient === normalizedRight.coefficient &&
    normalizedLeft.exponent === normalizedRight.exponent
  );
}

function isFaithfullyRepresentedNumberLiteral(literal: string): boolean {
  const value = Number(literal);
  if (!Number.isFinite(value)) return false;

  const serialized = JSON.stringify(value);
  return (
    typeof serialized === "string" &&
    decimalValuesAreEqual(literal, serialized)
  );
}

/**
 * The proven tool result is `full.body`. Preserve an unsafe integer only when
 * it is the provider attempt ID at `full.body.id`. Any other unsafe integer is
 * rejected because JSON.parse would silently round webhook payload data.
 */
function isUnsafeIntegerLiteral(literal: string): boolean {
  const normalized = normalizeDecimalLiteral(literal);
  if (normalized.kind === "zero" || normalized.exponent < 0) return false;

  const integerDigitCount =
    normalized.coefficient.length + normalized.exponent;
  if (integerDigitCount > MAX_SAFE_INTEGER_DECIMAL.length) return true;
  if (integerDigitCount < MAX_SAFE_INTEGER_DECIMAL.length) return false;

  const integer = normalized.coefficient.padEnd(
    MAX_SAFE_INTEGER_DECIMAL.length,
    "0",
  );
  return integer > MAX_SAFE_INTEGER_DECIMAL;
}

function parseProvenDeliveryJson(text: string): unknown {
  const unsafeIntegerSentinel = randomUUID();
  const unsafeIntegers: string[] = [];
  let protectedText = "";
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (inString) {
      protectedText += character;
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      protectedText += character;
      continue;
    }

    if (character === "-" || /[0-9]/.test(character)) {
      const match = text.slice(index).match(JSON_NUMBER_PATTERN);
      if (match !== null) {
        const literal = match[0];
        if (literal.length > MAX_JSON_NUMERIC_LITERAL_CHARS) {
          throw new GithubMcpError(
            "GitHub MCP returned a JSON numeric literal that is too long.",
          );
        }

        if (isUnsafeIntegerLiteral(literal)) {
          unsafeIntegers.push(literal);
          protectedText += `{"__redriveUnsafeInteger":${JSON.stringify(
            unsafeIntegerSentinel,
          )}}`;
        } else {
          if (!isFaithfullyRepresentedNumberLiteral(literal)) {
            throw new GithubMcpError(
              "GitHub MCP returned a numeric value that cannot be represented faithfully.",
            );
          }
          protectedText += literal;
        }
        index += literal.length - 1;
        continue;
      }
    }

    protectedText += character;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(protectedText) as unknown;
  } catch {
    throw new GithubMcpError("GitHub MCP returned invalid JSON.");
  }

  if (unsafeIntegers.length === 0) {
    return parsed;
  }

  const root = isRecord(parsed) ? parsed : null;
  const full = root !== null && isRecord(root.full) ? root.full : null;
  const body = full !== null && isRecord(full.body) ? full.body : null;
  const marker = body !== null && isRecord(body.id) ? body.id : null;

  if (
    unsafeIntegers.length !== 1 ||
    body === null ||
    marker === null ||
    Object.keys(marker).length !== 1 ||
    marker.__redriveUnsafeInteger !== unsafeIntegerSentinel
  ) {
    throw new GithubMcpError(
      "GitHub MCP returned an unsafe integer outside full.body.id.",
    );
  }

  body.id = unsafeIntegers[0];
  return parsed;
}

function parseJsonRpcEnvelope(text: string, requestId: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(text) as unknown;
  } catch {
    throw new GithubMcpError("GitHub MCP returned invalid JSON-RPC.");
  }

  if (
    !isRecord(envelope) ||
    envelope.jsonrpc !== "2.0" ||
    typeof envelope.id !== "string"
  ) {
    throw new GithubMcpError("GitHub MCP returned an invalid JSON-RPC envelope.");
  }

  if (envelope.id !== requestId) {
    throw new GithubMcpError("GitHub MCP returned a response ID that does not match the request ID.");
  }

  if (Object.prototype.hasOwnProperty.call(envelope, "error")) {
    throw new GithubMcpError("GitHub MCP returned a tool error.");
  }

  const result = envelope.result;
  if (!isRecord(result) || result.isError === true) {
    throw new GithubMcpError("GitHub MCP returned a tool error.");
  }

  if (!Array.isArray(result.content) || result.content.length !== 1) {
    throw new GithubMcpError(
      "GitHub MCP result must contain exactly one text item.",
    );
  }

  const item = result.content[0];
  if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") {
    throw new GithubMcpError("GitHub MCP result text item is invalid.");
  }

  return parseProvenDeliveryJson(item.text);
}

function parseTransportResponse(
  response: Response,
  text: string,
  requestId: string,
): unknown {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();

  if (mediaType === "application/json") {
    return parseJsonRpcEnvelope(text.trim(), requestId);
  }

  if (mediaType === "text/event-stream") {
    const normalized = text.replace(/\r\n/g, "\n");
    const match = normalized.match(/^event: message\ndata: ([^\n]+)\n\n$/);
    if (match === null) {
      throw new GithubMcpError(
        "GitHub MCP event stream does not match the proven bridge format.",
      );
    }
    return parseJsonRpcEnvelope(match[1], requestId);
  }

  throw new GithubMcpError("GitHub MCP returned an unsupported media type.");
}

async function readChunkWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    throw new DOMException("The operation was aborted", "AbortError");
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new DOMException("The operation was aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    reader.read().then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

async function readResponseBody(response: Response, signal: AbortSignal): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const parsedLength = Number(contentLength);
    if (Number.isFinite(parsedLength) && parsedLength > GITHUB_MCP_MAX_RESPONSE_BYTES) {
      throw new GithubMcpResponseTooLargeError();
    }
  }

  if (response.body === null) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      // The request's AbortController also aborts a pending stream read.
      const chunk = await readChunkWithAbort(reader, signal);
      if (chunk.done) {
        text += decoder.decode();
        return text;
      }
      bytes += chunk.value.byteLength;
      if (bytes > GITHUB_MCP_MAX_RESPONSE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // The size error is the useful, bounded failure even if cancellation fails.
        }
        throw new GithubMcpResponseTooLargeError();
      }
      text += decoder.decode(chunk.value, { stream: true });
      if (signal.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A pending read may keep the lock while abort is propagating.
    }
  }
}

export function createGithubMcpToolCaller(options: {
  endpoint: string;
  token?: string;
  fetchImplementation?: typeof fetch;
}): GithubMcpToolCaller {
  const endpoint = options.endpoint.trim();
  if (endpoint.length === 0) {
    throw new GithubMcpConfigurationError(
      "REDRIVE_GITHUB_MCP_URL must not be empty.",
    );
  }

  try {
    new URL(endpoint);
  } catch {
    throw new GithubMcpConfigurationError(
      "REDRIVE_GITHUB_MCP_URL must be a valid URL.",
    );
  }

  const fetchImplementation = options.fetchImplementation ?? fetch;

  return async (_toolName, input) => {
    const controller = new AbortController();
    const requestId = randomUUID();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, GITHUB_MCP_TIMEOUT_MS);

    try {
      let response: Response;
      try {
        response = await fetchImplementation(endpoint, {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...(options.token === undefined || options.token.length === 0
              ? {}
              : { Authorization: `Bearer ${options.token}` }),
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: requestId,
            method: "tools/call",
            params: {
              name: GITHUB_WEBHOOK_DELIVERY_TOOL,
              arguments: input,
            },
          }),
          signal: controller.signal,
        });
      } catch {
        if (timedOut) throw new GithubMcpTimeoutError();
        throw new GithubMcpError("GitHub MCP request failed.");
      }

      let responseText: string;
      try {
        responseText = await readResponseBody(response, controller.signal);
      } catch (error) {
        if (timedOut || (error instanceof DOMException && error.name === "AbortError")) {
          throw new GithubMcpTimeoutError();
        }
        throw error instanceof GithubMcpResponseTooLargeError
          ? error
          : new GithubMcpError("GitHub MCP response could not be read.");
      }

      if (!response.ok) {
        throw new GithubMcpError(
          `GitHub MCP request failed with HTTP ${response.status}.`,
        );
      }

      return parseTransportResponse(response, responseText, requestId);
    } finally {
      clearTimeout(timeout);
    }

  };
}

export function createGithubWebhookDeliveryReader(
  callTool: GithubMcpToolCaller,
  resolveHookId: GithubHookIdResolver,
): GithubWebhookDeliveryReader {
  return {
    async getWebhookDelivery(lookup) {
      if (
        typeof lookup.repositoryId !== "string" ||
        lookup.repositoryId.length === 0 ||
        typeof lookup.deliveryId !== "string" ||
        lookup.deliveryId.length === 0
      ) {
        throw new GithubMcpConfigurationError(
          "GitHub webhook lookup identifiers must be non-empty strings.",
        );
      }

      const hookId = resolveHookId(lookup.repositoryId);

      if (typeof hookId !== "string" || hookId.length === 0) {
        throw new GithubMcpConfigurationError(
          "A GitHub webhook hook ID is required.",
        );
      }

      return callTool(GITHUB_WEBHOOK_DELIVERY_TOOL, {
        // The custom GitHub MCP boundary requires hook_id. It is intentionally
        // resolved from explicit configuration, never guessed from repositoryId.
        hook_id: hookId,
        delivery_id: lookup.deliveryId,
      });
    },
  };
}

function readHookIdMap(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const encodedMap = environment.REDRIVE_GITHUB_HOOK_IDS;
  if (encodedMap === undefined || encodedMap.trim().length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedMap);
  } catch {
    throw new GithubMcpConfigurationError(
      "REDRIVE_GITHUB_HOOK_IDS must be valid JSON.",
    );
  }

  if (!isRecord(parsed)) {
    throw new GithubMcpConfigurationError(
      "REDRIVE_GITHUB_HOOK_IDS must be a JSON object.",
    );
  }

  const hookIds: Record<string, string> = {};
  for (const [repositoryId, hookId] of Object.entries(parsed)) {
    if (typeof hookId !== "string" || hookId.length === 0) {
      throw new GithubMcpConfigurationError(
        "REDRIVE_GITHUB_HOOK_IDS values must be non-empty strings.",
      );
    }

    hookIds[repositoryId] = hookId;
  }

  return hookIds;
}

export function createConfiguredGithubWebhookDeliveryReader(
  environment: NodeJS.ProcessEnv = process.env,
  fetchImplementation: typeof fetch = fetch,
): GithubWebhookDeliveryReader {
  const endpoint = environment.REDRIVE_GITHUB_MCP_URL;
  if (endpoint === undefined || endpoint.trim().length === 0) {
    throw new GithubMcpConfigurationError(
      "REDRIVE_GITHUB_MCP_URL is required for GitHub provider inspection.",
    );
  }

  const hookIds = readHookIdMap(environment);
  const singleHookId = environment.REDRIVE_GITHUB_HOOK_ID?.trim();
  const callTool = createGithubMcpToolCaller({
    endpoint,
    token: environment.REDRIVE_GITHUB_MCP_TOKEN,
    fetchImplementation,
  });

  return createGithubWebhookDeliveryReader(callTool, (repositoryId) => {
    const hookId = hookIds[repositoryId] ?? singleHookId;

    if (hookId === undefined || hookId.length === 0) {
      throw new GithubMcpConfigurationError(
        "No explicit GitHub webhook hook ID is configured for repository " +
          `${repositoryId}.`,
      );
    }

    return hookId;
  });
}
