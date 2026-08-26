import { randomUUID } from "node:crypto";

export const GITHUB_WEBHOOK_DELIVERY_TOOL = "get_webhook_delivery" as const;

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

export class GithubMcpConfigurationError extends GithubMcpError {
  constructor(message: string) {
    super(message);
    this.name = "GithubMcpConfigurationError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON.parse rounds integers before a reviver can inspect them. Protect integer
 * literals that cannot be represented safely so opaque provider IDs stay
 * strings at the MCP boundary instead of becoming different numbers.
 */
function parseJsonPreservingOpaqueIntegers(text: string): unknown {
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
      const remaining = text.slice(index);
      const match = remaining.match(
        /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/,
      );

      if (match !== null) {
        const literal = match[0];
        const numberValue = Number(literal);

        if (
          /^-?(?:0|[1-9][0-9]*)$/.test(literal) &&
          !Number.isSafeInteger(numberValue)
        ) {
          protectedText += `"${literal}"`;
        } else {
          protectedText += literal;
        }

        index += literal.length - 1;
        continue;
      }
    }

    protectedText += character;
  }

  try {
    return JSON.parse(protectedText) as unknown;
  } catch {
    throw new GithubMcpError("GitHub MCP returned invalid JSON.");
  }
}

function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    throw new GithubMcpError("GitHub MCP returned an empty response.");
  }

  if (!trimmed.startsWith("event:")) {
    return parseJsonPreservingOpaqueIntegers(trimmed);
  }

  const dataLines = trimmed
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .filter((line) => line.length > 0 && line !== "[DONE]");

  const lastDataLine = dataLines.at(-1);
  if (lastDataLine === undefined) {
    throw new GithubMcpError("GitHub MCP returned an empty event stream.");
  }

  return parseJsonPreservingOpaqueIntegers(lastDataLine);
}

function unwrapMcpToolResult(envelope: unknown): unknown {
  if (!isRecord(envelope)) {
    return envelope;
  }

  if (isRecord(envelope.error)) {
    throw new GithubMcpError("GitHub MCP returned a tool error.");
  }

  if (!Object.prototype.hasOwnProperty.call(envelope, "result")) {
    return envelope;
  }

  const result = envelope.result;
  if (!isRecord(result)) {
    return result;
  }

  if (result.isError === true) {
    throw new GithubMcpError("GitHub MCP returned a tool error.");
  }

  if (Object.prototype.hasOwnProperty.call(result, "structuredContent")) {
    return result.structuredContent;
  }

  if (Array.isArray(result.content)) {
    const textContent = result.content.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "text" && typeof item.text === "string",
    );

    if (textContent !== undefined) {
      return parseMcpResponse(textContent.text as string);
    }
  }

  return result;
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
          id: randomUUID(),
          method: "tools/call",
          params: {
            name: GITHUB_WEBHOOK_DELIVERY_TOOL,
            arguments: input,
          },
        }),
      });
    } catch (error) {
      throw new GithubMcpError("GitHub MCP request failed.", {
        cause: error,
      });
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new GithubMcpError("GitHub MCP response could not be read.", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new GithubMcpError(
        `GitHub MCP request failed with HTTP ${response.status}.`,
      );
    }

    return unwrapMcpToolResult(parseMcpResponse(responseText));
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
