import {
  GithubRestJsonError,
  readGithubRestJson,
  readGithubRestResponseText,
} from "@/server/github/github-rest-json";

export const GITHUB_API_BASE_URL = "https://api.github.com" as const;
// Current version observed in GitHub's API Versions documentation during M2.6A.
export const GITHUB_API_VERSION = "2026-03-10" as const;
export const GITHUB_REST_TIMEOUT_MS = 12_000;
export const GITHUB_REST_MAX_PAGES = 20;
// Retry timing is advisory metadata only. Keep it bounded so an untrusted
// response header cannot create an unbounded value for callers to display or
// persist.
export const GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MAX_RATE_LIMIT_REMAINING = 1_000_000_000;
const MAX_RATE_LIMIT_RESET_EPOCH_SECONDS = 9_999_999_999;

export interface GithubRateLimitMetadata {
  readonly retryAfterSeconds: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetEpochSeconds: number | null;
}

const EMPTY_RATE_LIMIT_METADATA: GithubRateLimitMetadata = {
  retryAfterSeconds: null,
  rateLimitRemaining: null,
  rateLimitResetEpochSeconds: null,
};

export class GithubRestError extends Error {
  readonly status: number | null;
  readonly code:
    | "CONFIGURATION"
    | "TIMEOUT"
    | "NETWORK"
    | "HTTP"
    | "INVALID_RESPONSE"
    | "UNSUPPORTED_MEDIA";
  // These are parsed, bounded values only. Raw response headers and bodies are
  // deliberately never retained on the error.
  readonly rateLimit: GithubRateLimitMetadata;
  readonly retryAfterSeconds: number | null;
  readonly rateLimitRemaining: number | null;
  readonly rateLimitResetEpochSeconds: number | null;

  constructor(
    code: GithubRestError["code"],
    message: string,
    status: number | null = null,
    rateLimit: GithubRateLimitMetadata = EMPTY_RATE_LIMIT_METADATA,
  ) {
    super(message);
    this.name = "GithubRestError";
    this.code = code;
    this.status = status;
    this.rateLimit = rateLimit;
    this.retryAfterSeconds = rateLimit.retryAfterSeconds;
    this.rateLimitRemaining = rateLimit.rateLimitRemaining;
    this.rateLimitResetEpochSeconds = rateLimit.rateLimitResetEpochSeconds;
  }
}

export interface GithubRestRequestOptions {
  method?: "GET" | "POST";
  token?: string;
  body?: unknown;
}

function encodePathSegment(value: string, field: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) {
    throw new GithubRestError(
      "CONFIGURATION",
      `GitHub ${field} is invalid.`,
    );
  }
  return encodeURIComponent(value);
}

class GithubRestRawInteger {
  constructor(readonly value: string) {}
}

function serializeRequestJson(value: unknown, seen = new Set<unknown>()): string {
  if (value instanceof GithubRestRawInteger) return value.value;
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new GithubRestError("CONFIGURATION", "GitHub REST request contains an invalid number.");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new GithubRestError("CONFIGURATION", "GitHub REST request is cyclic.");
    seen.add(value);
    const result = `[${value.map((item) => serializeRequestJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new GithubRestError("CONFIGURATION", "GitHub REST request is cyclic.");
    seen.add(value);
    const result = `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}:${serializeRequestJson(item, seen)}`)
      .join(",")}}`;
    seen.delete(value);
    return result;
  }
  throw new GithubRestError("CONFIGURATION", "GitHub REST request contains an unsupported value.");
}

function repositoryPath(repositoryFullName: string): string {
  if (
    typeof repositoryFullName !== "string" ||
    !/^[^/\s]{1,255}\/[^/\s]{1,255}$/.test(repositoryFullName)
  ) {
    throw new GithubRestError(
      "CONFIGURATION",
      "GitHub repository full name is invalid.",
    );
  }
  const [owner, repository] = repositoryFullName.split("/");
  return `/repos/${encodePathSegment(owner, "repository owner")}/${encodePathSegment(repository, "repository name")}`;
}

function splitLinkHeader(value: string): string[] {
  const links: string[] = [];
  let start = 0;
  let inAngleBrackets = false;
  let inQuotes = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inQuotes) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inQuotes = false;
      }
      continue;
    }
    if (character === '"') {
      inQuotes = true;
    } else if (character === "<") {
      inAngleBrackets = true;
    } else if (character === ">") {
      inAngleBrackets = false;
    } else if (character === "," && !inAngleBrackets) {
      links.push(value.slice(start, index));
      start = index + 1;
    }
  }
  links.push(value.slice(start));
  return links;
}

function nextCursorFromLink(
  linkHeader: string | null,
  expectedPath: string,
): string | null {
  if (linkHeader === null || linkHeader.length === 0) return null;

  for (const link of splitLinkHeader(linkHeader)) {
    const match = link.match(/^\s*<([^>]*)>\s*;(.*)$/);
    if (match === null) continue;
    const [, target, parameters] = match;
    const relParameter = parameters
      .split(";")
      .map((parameter) => parameter.trim())
      .find((parameter) => /^rel\s*=/i.test(parameter));
    if (relParameter === undefined) continue;
    const relValue = relParameter.match(/^rel\s*=\s*(?:"([^"]*)"|([^\s]+))\s*$/i);
    if (relValue === null) continue;
    const relations = (relValue[1] ?? relValue[2]).split(/\s+/);
    if (!relations.includes("next")) continue;

    let nextUrl: URL;
    try {
      nextUrl = new URL(target, GITHUB_API_BASE_URL);
    } catch {
      continue;
    }
    if (
      nextUrl.origin !== new URL(GITHUB_API_BASE_URL).origin ||
      nextUrl.pathname !== expectedPath ||
      nextUrl.username !== "" ||
      nextUrl.password !== "" ||
      nextUrl.hash !== ""
    ) {
      continue;
    }
    const cursors = nextUrl.searchParams.getAll("cursor");
    if (cursors.length !== 1 || cursors[0].length === 0) continue;
    return cursors[0];
  }
  return null;
}

function isJsonMediaType(response: Response): boolean {
  const mediaType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  return (
    mediaType === "application/json" ||
    mediaType === "application/vnd.github+json"
  );
}

function parseBoundedHeaderInteger(
  value: string | null,
  maximum: number,
): number | null {
  if (value === null || !/^\d+$/.test(value.trim())) return null;
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) return null;
  return Math.min(parsed, maximum);
}

const IMF_FIXDATE_PATTERN = /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat), ([0-9]{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([0-9]{4}) ([0-9]{2}):([0-9]{2}):([0-9]{2}) GMT$/;
const IMF_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const IMF_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

function parseImfFixdate(value: string): number | null {
  const match = IMF_FIXDATE_PATTERN.exec(value);
  if (match === null) return null;

  const [, weekday, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const monthIndex = IMF_MONTHS.indexOf(monthText as (typeof IMF_MONTHS)[number]);
  const day = Number(dayText);
  const year = Number(yearText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  if (monthIndex < 0 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  // Build the UTC value from the validated fields, then compare every field
  // back to the input. This rejects impossible dates and mismatched weekdays
  // without allowing Date.parse to accept non-IMF date forms.
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second ||
    IMF_WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    return null;
  }
  return date.getTime();
}

function parseRetryAfter(
  value: string | null,
  nowMs: number,
): number | null {
  if (value === null) return null;
  const normalized = value.trim();
  const deltaSeconds = parseBoundedHeaderInteger(
    normalized,
    GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
  );
  if (deltaSeconds !== null) return deltaSeconds;

  const retryAtMs = parseImfFixdate(normalized);
  if (retryAtMs === null) return null;
  return Math.min(
    Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000)),
    GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
  );
}

function readGithubRateLimitMetadata(
  headers: Headers,
  nowMs = Date.now(),
): GithubRateLimitMetadata {
  const rateLimitRemaining = parseBoundedHeaderInteger(
    headers.get("x-ratelimit-remaining"),
    MAX_RATE_LIMIT_REMAINING,
  );
  const rateLimitResetEpochSeconds = parseBoundedHeaderInteger(
    headers.get("x-ratelimit-reset"),
    MAX_RATE_LIMIT_RESET_EPOCH_SECONDS,
  );
  const headerRetryAfterSeconds = parseRetryAfter(
    headers.get("retry-after"),
    nowMs,
  );
  const retryAfterSeconds =
    headerRetryAfterSeconds ??
    (rateLimitRemaining === 0 && rateLimitResetEpochSeconds !== null
      ? Math.min(
          Math.max(0, rateLimitResetEpochSeconds - Math.floor(nowMs / 1000)),
          GITHUB_RATE_LIMIT_MAX_RETRY_AFTER_SECONDS,
        )
      : null);

  return {
    retryAfterSeconds,
    rateLimitRemaining,
    rateLimitResetEpochSeconds,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export class GithubApi {
  private readonly fetchImplementation: typeof fetch;

  constructor(options: { fetchImplementation?: typeof fetch } = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  async requestJson(
    path: string,
    options: GithubRestRequestOptions = {},
  ): Promise<unknown> {
    const response = await this.requestJsonWithMetadata(path, options);
    return response.value;
  }

  private async requestJsonWithMetadata(
    path: string,
    options: GithubRestRequestOptions = {},
  ): Promise<{ value: unknown; link: string | null }> {
    if (!path.startsWith("/") || path.includes("://") || path.includes("\\")) {
      throw new GithubRestError(
        "CONFIGURATION",
        "GitHub REST paths must be constructed locally.",
      );
    }
    if (options.token !== undefined && options.token.length === 0) {
      throw new GithubRestError("CONFIGURATION", "GitHub credential is empty.");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_REST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${GITHUB_API_BASE_URL}${path}`,
        {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "Redrive-GitHub-App-Connection",
            ...(options.token === undefined
              ? {}
              : { Authorization: `Bearer ${options.token}` }),
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: serializeRequestJson(options.body) }),
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      if (isAbortError(error)) {
        throw new GithubRestError(
          "TIMEOUT",
          "GitHub REST request timed out.",
        );
      }
      throw new GithubRestError("NETWORK", "GitHub REST request failed.");
    }

    try {
      if (!response.ok) {
        const rateLimit = readGithubRateLimitMetadata(response.headers);
        // Read and bound the body so a hostile error response cannot remain an
        // unbounded stream. The body is deliberately not included in the error.
        try {
          await readGithubRestResponseText(response, controller.signal);
        } catch (error) {
          if (isAbortError(error)) {
            throw new GithubRestError(
              "TIMEOUT",
              "GitHub REST request timed out.",
            );
          }
          // The body is intentionally not exposed for an HTTP error.
        }
        throw new GithubRestError(
          "HTTP",
          `GitHub REST request failed with HTTP ${response.status}.`,
          response.status,
          rateLimit,
        );
      }
      if (!isJsonMediaType(response)) {
        throw new GithubRestError(
          "UNSUPPORTED_MEDIA",
          "GitHub REST returned an unsupported media type.",
          response.status,
        );
      }

      try {
        return {
          value: await readGithubRestJson(response, controller.signal),
          link: response.headers.get("link"),
        };
      } catch (error) {
        if (isAbortError(error)) {
          throw new GithubRestError(
            "TIMEOUT",
            "GitHub REST request timed out.",
          );
        }
        if (error instanceof GithubRestJsonError) {
          throw new GithubRestError(
            "INVALID_RESPONSE",
            "GitHub REST returned an invalid response.",
            response.status,
          );
        }
        throw error;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * GitHub's webhook redelivery endpoint accepts a POST and normally returns
   * HTTP 202 with no JSON document. Keep this path separate from requestJson:
   * callers must not weaken JSON validation for the rest of the API.
   */
  private async requestEmptySuccess(
    path: string,
    options: GithubRestRequestOptions = {},
  ): Promise<number> {
    if (!path.startsWith("/") || path.includes("://") || path.includes("\\")) {
      throw new GithubRestError(
        "CONFIGURATION",
        "GitHub REST paths must be constructed locally.",
      );
    }
    if (options.token !== undefined && options.token.length === 0) {
      throw new GithubRestError("CONFIGURATION", "GitHub credential is empty.");
    }
    if (options.body !== undefined) {
      throw new GithubRestError(
        "CONFIGURATION",
        "GitHub empty-success requests cannot contain a body.",
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), GITHUB_REST_TIMEOUT_MS);
    let response: Response;
    try {
      response = await this.fetchImplementation(
        `${GITHUB_API_BASE_URL}${path}`,
        {
          method: options.method ?? "GET",
          headers: {
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": GITHUB_API_VERSION,
            "User-Agent": "Redrive-GitHub-App-Connection",
            ...(options.token === undefined
              ? {}
              : { Authorization: `Bearer ${options.token}` }),
          },
          redirect: "error",
          signal: controller.signal,
        },
      );
    } catch (error) {
      clearTimeout(timeout);
      if (isAbortError(error)) {
        throw new GithubRestError(
          "TIMEOUT",
          "GitHub REST request timed out.",
        );
      }
      throw new GithubRestError("NETWORK", "GitHub REST request failed.");
    }

    try {
      if (!response.ok) {
        const rateLimit = readGithubRateLimitMetadata(response.headers);
        try {
          await readGithubRestResponseText(response, controller.signal);
        } catch (error) {
          if (isAbortError(error)) {
            throw new GithubRestError(
              "TIMEOUT",
              "GitHub REST request timed out.",
            );
          }
        }
        throw new GithubRestError(
          "HTTP",
          `GitHub REST request failed with HTTP ${response.status}.`,
          response.status,
          rateLimit,
        );
      }

      try {
        await readGithubRestResponseText(response, controller.signal);
      } catch (error) {
        if (isAbortError(error)) {
          throw new GithubRestError(
            "TIMEOUT",
            "GitHub REST request timed out.",
          );
        }
        throw new GithubRestError(
          "INVALID_RESPONSE",
          "GitHub REST returned an invalid empty-success response.",
          response.status,
        );
      }
      return response.status;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async listPaginated(
    path: string,
    description: string,
    token: string,
  ): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= GITHUB_REST_MAX_PAGES; page += 1) {
      const result = await this.requestJson(
        `${path}?per_page=100&page=${page}`,
        { token },
      );
      if (!Array.isArray(result)) {
        throw new GithubRestError(
          "INVALID_RESPONSE",
          `GitHub ${description} response is invalid.`,
        );
      }
      values.push(...result);
      if (result.length < 100) return values;
    }
    throw new GithubRestError(
      "INVALID_RESPONSE",
      `GitHub ${description} pagination exceeded the safety bound.`,
    );
  }

  convertManifest(code: string): Promise<unknown> {
    return this.requestJson(
      `/app-manifests/${encodePathSegment(code, "manifest code")}/conversions`,
      { method: "POST" },
    );
  }

  getInstallation(installationId: string, appJwt: string): Promise<unknown> {
    return this.requestJson(
      `/app/installations/${encodePathSegment(installationId, "installation ID")}`,
      { method: "GET", token: appJwt },
    );
  }

  createInstallationToken(
    installationId: string,
    appJwt: string,
    repositoryIds?: string[],
  ): Promise<unknown> {
    let body: unknown = {};
    if (repositoryIds !== undefined) {
      if (repositoryIds.length === 0 || repositoryIds.length > 100) {
        throw new GithubRestError(
          "CONFIGURATION",
          "GitHub repository selection is invalid.",
        );
      }
      const rawRepositoryIds = repositoryIds.map((repositoryId) => {
        if (
          typeof repositoryId !== "string" ||
          !/^(?:0|[1-9][0-9]*)$/.test(repositoryId)
        ) {
          throw new GithubRestError(
            "CONFIGURATION",
            "GitHub repository selection is invalid.",
          );
        }
        return new GithubRestRawInteger(repositoryId);
      });
      body = { repository_ids: rawRepositoryIds };
    }
    return this.requestJson(
      `/app/installations/${encodePathSegment(installationId, "installation ID")}/access_tokens`,
      { method: "POST", token: appJwt, body },
    );
  }

  async listInstallationRepositories(installationToken: string): Promise<unknown[]> {
    const repositories: unknown[] = [];
    for (let page = 1; page <= GITHUB_REST_MAX_PAGES; page += 1) {
      const result = await this.requestJson(
        `/installation/repositories?per_page=100&page=${page}`,
        { token: installationToken },
      );
      if (
        result === null ||
        typeof result !== "object" ||
        Array.isArray(result) ||
        !Array.isArray((result as Record<string, unknown>).repositories)
      ) {
        throw new GithubRestError(
          "INVALID_RESPONSE",
          "GitHub installation repositories response is invalid.",
        );
      }
      const pageRepositories = (result as Record<string, unknown>).repositories;
      if (!Array.isArray(pageRepositories)) {
        throw new GithubRestError(
          "INVALID_RESPONSE",
          "GitHub installation repositories response is invalid.",
        );
      }
      repositories.push(...pageRepositories);
      if (pageRepositories.length < 100) return repositories;
    }
    throw new GithubRestError(
      "INVALID_RESPONSE",
      "GitHub installation repository pagination exceeded the safety bound.",
    );
  }

  listRepositoryHooks(
    repositoryFullName: string,
    installationToken: string,
  ): Promise<unknown[]> {
    return this.listPaginated(
      `${repositoryPath(repositoryFullName)}/hooks`,
      "repository hooks",
      installationToken,
    );
  }

  getRepositoryHook(
    repositoryFullName: string,
    webhookId: string,
    installationToken: string,
  ): Promise<unknown> {
    return this.requestJson(
      `${repositoryPath(repositoryFullName)}/hooks/${encodePathSegment(webhookId, "webhook ID")}`,
      { token: installationToken },
    );
  }

  async listWebhookDeliveries(
    repositoryFullName: string,
    webhookId: string,
    installationToken: string,
  ): Promise<unknown[]> {
    const path = `${repositoryPath(repositoryFullName)}/hooks/${encodePathSegment(webhookId, "webhook ID")}/deliveries`;
    const values: unknown[] = [];
    let cursor: string | null = null;

    for (let request = 0; request < GITHUB_REST_MAX_PAGES; request += 1) {
      const query = new URLSearchParams({ per_page: "100" });
      if (cursor !== null) query.set("cursor", cursor);
      const response = await this.requestJsonWithMetadata(
        `${path}?${query.toString()}`,
        { token: installationToken },
      );
      if (!Array.isArray(response.value)) {
        throw new GithubRestError(
          "INVALID_RESPONSE",
          "GitHub webhook deliveries response is invalid.",
        );
      }
      values.push(...response.value);
      cursor = nextCursorFromLink(response.link, path);
      if (cursor === null) return values;
    }
    throw new GithubRestError(
      "INVALID_RESPONSE",
      "GitHub webhook deliveries pagination exceeded the safety bound.",
    );
  }

  getWebhookDelivery(
    repositoryFullName: string,
    webhookId: string,
    deliveryId: string,
    installationToken: string,
  ): Promise<unknown> {
    return this.requestJson(
      `${repositoryPath(repositoryFullName)}/hooks/${encodePathSegment(webhookId, "webhook ID")}/deliveries/${encodePathSegment(deliveryId, "delivery ID")}`,
      { token: installationToken },
    );
  }

  redeliverWebhookDelivery(
    repositoryFullName: string,
    webhookId: string,
    deliveryId: string,
    installationToken: string,
  ): Promise<number> {
    return this.requestEmptySuccess(
      `${repositoryPath(repositoryFullName)}/hooks/${encodePathSegment(webhookId, "webhook ID")}/deliveries/${encodePathSegment(deliveryId, "delivery ID")}/attempts`,
      { method: "POST", token: installationToken },
    );
  }
}

export function createGithubApi(options: { fetchImplementation?: typeof fetch } = {}): GithubApi {
  return new GithubApi(options);
}
