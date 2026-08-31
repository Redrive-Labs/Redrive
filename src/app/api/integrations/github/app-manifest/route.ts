import { NextResponse } from "next/server";
import { GithubIntegrationValidationError } from "@/domain/github-integration";
import {
  createManifestAttempt,
} from "@/server/github/github-app-service";
import {
  getRequiredRedrivePublicUrl,
  getServerConfig,
  ServerConfigurationError,
} from "@/server/infrastructure/config";
import { getConfiguredDatabase } from "@/server/infrastructure/database";
import {
  GithubRouteBodyError,
  readBoundedBody,
} from "@/server/github/github-route-utils";
import { MAX_MANIFEST_REQUEST_BODY_BYTES } from "@/server/infrastructure/request-body-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

class ManifestRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManifestRequestError";
  }
}

async function readRequestInput(request: Request): Promise<unknown> {
  let body: Uint8Array;
  try {
    body = await readBoundedBody(request, MAX_MANIFEST_REQUEST_BODY_BYTES);
  } catch (error) {
    if (error instanceof GithubRouteBodyError) {
      throw new ManifestRequestError(error.message);
    }
    throw error;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new ManifestRequestError("Request body contains malformed UTF-8.");
  }
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.startsWith("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(text);
    return {
      targetType: form.get("targetType") ?? form.get("target"),
      ownerLogin: form.get("ownerLogin") || undefined,
    };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ManifestRequestError("Request body must be valid JSON or form data.");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function wantsJson(request: Request): boolean {
  return request.headers.get("accept")?.includes("application/json") ?? false;
}

function errorResponse(error: unknown): Response {
  if (error instanceof ManifestRequestError) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  if (error instanceof GithubIntegrationValidationError) {
    return NextResponse.json(
      { error: error.message, issues: error.issues },
      { status: 400 },
    );
  }
  if (error instanceof ServerConfigurationError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return NextResponse.json(
    { error: "GitHub App manifest setup is unavailable." },
    { status: 503 },
  );
}

function manifestForm(
  githubRegistrationUrl: string,
  manifest: object,
): Response {
  const encodedManifest = escapeHtml(JSON.stringify(manifest));
  const encodedAction = escapeHtml(githubRegistrationUrl);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Connect GitHub · Redrive</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #111512;
        --card: #1a201c;
        --card-raised: #202721;
        --ink: #f4f1e8;
        --muted: #adb6ad;
        --line: #3a453d;
        --accent: #dd7045;
        --accent-bright: #f08a5c;
      }

      * { box-sizing: border-box; }

      html { min-height: 100%; background: var(--bg); }

      body {
        min-height: 100vh;
        margin: 0;
        background: var(--bg);
        color: var(--ink);
        font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 16px;
        line-height: 1.5;
      }

      .page {
        display: grid;
        min-height: 100vh;
        place-items: center;
        padding: 2rem 1.25rem;
      }

      .card {
        width: min(100%, 35rem);
        padding: clamp(1.5rem, 5vw, 2.5rem);
        border: 1px solid var(--line);
        background: var(--card);
        box-shadow: 0 1.5rem 4rem rgba(0, 0, 0, 0.24);
      }

      .brand {
        display: flex;
        align-items: center;
        gap: 0.7rem;
        padding-bottom: 1.4rem;
        border-bottom: 1px solid var(--line);
      }

      .brand-mark {
        width: 0.65rem;
        height: 0.65rem;
        background: var(--accent);
        box-shadow: 0 0 0 0.3rem rgba(221, 112, 69, 0.12);
      }

      .brand-name,
      .brand-role,
      .eyebrow {
        margin: 0;
        text-transform: uppercase;
        letter-spacing: 0.16em;
        font-family: "SFMono-Regular", Consolas, "Liberation Mono", monospace;
        font-weight: 700;
      }

      .brand-name { font-size: 0.72rem; }
      .brand-role { margin-top: 0.18rem; color: var(--muted); font-size: 0.57rem; }

      .eyebrow {
        margin-top: 2.2rem;
        color: var(--accent-bright);
        font-size: 0.6rem;
      }

      h1 {
        margin: 0.55rem 0 0;
        font-family: Georgia, "Times New Roman", serif;
        font-size: clamp(2.35rem, 8vw, 3.5rem);
        font-weight: 400;
        letter-spacing: -0.055em;
        line-height: 0.98;
      }

      .intro {
        max-width: 29rem;
        margin: 1.1rem 0 0;
        color: var(--muted);
        font-size: 0.98rem;
        line-height: 1.65;
      }

      .scope {
        display: grid;
        gap: 0.7rem;
        margin: 1.7rem 0 0;
        padding: 1.05rem 1.15rem;
        border: 1px solid var(--line);
        background: var(--card-raised);
        list-style: none;
      }

      .scope li {
        display: grid;
        grid-template-columns: 0.45rem 1fr;
        align-items: start;
        gap: 0.7rem;
        color: var(--ink);
        font-size: 0.84rem;
        line-height: 1.45;
      }

      .scope li::before {
        width: 0.4rem;
        height: 0.4rem;
        margin-top: 0.38rem;
        background: var(--accent);
        content: "";
      }

      form { margin-top: 1.7rem; }

      button {
        width: 100%;
        min-height: 3.1rem;
        border: 1px solid var(--accent);
        border-radius: 0;
        background: var(--accent);
        color: #1a120e;
        cursor: pointer;
        font: inherit;
        font-size: 0.92rem;
        font-weight: 800;
        letter-spacing: 0.01em;
        transition: background-color 160ms ease, border-color 160ms ease, transform 160ms ease;
      }

      button:hover { border-color: var(--accent-bright); background: var(--accent-bright); }
      button:active { transform: translateY(1px); }
      button:focus-visible { outline: 3px solid var(--accent-bright); outline-offset: 4px; }

      .help {
        margin: 1rem 0 0;
        color: var(--muted);
        font-size: 0.75rem;
        line-height: 1.5;
        text-align: center;
      }

      @media (prefers-reduced-motion: reduce) {
        button { transition: none; }
      }

      @media (max-width: 30rem) {
        .page { padding: 1rem; }
        .card { padding: 1.35rem; }
        .eyebrow { margin-top: 1.8rem; }
      }
    </style>
  </head>
  <body>
    <main class="page">
      <section class="card" aria-labelledby="page-title">
        <header class="brand">
          <span class="brand-mark" aria-hidden="true"></span>
          <div>
            <p class="brand-name">Redrive</p>
            <p class="brand-role">CONTROL PLANE</p>
          </div>
        </header>
        <p class="eyebrow">Application connection</p>
        <h1 id="page-title">Connect GitHub</h1>
        <p class="intro">Redrive creates a narrowly scoped GitHub App for delivery investigation.</p>
        <ul class="scope" aria-label="GitHub App scope">
          <li>Read webhook delivery evidence</li>
          <li>Install only on repositories you choose</li>
          <li>Recovery actions remain separately human-gated</li>
        </ul>
        <form method="post" action="${encodedAction}">
          <input type="hidden" name="manifest" value="${encodedManifest}">
          <button type="submit">Continue to GitHub</button>
        </form>
        <p class="help">You’ll review the requested permissions on GitHub before creating the app.</p>
      </section>
    </main>
  </body>
</html>`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = await readRequestInput(request);
    const config = getServerConfig();
    const publicUrl = getRequiredRedrivePublicUrl();
    const database = getConfiguredDatabase(config.databasePath);
    const created = createManifestAttempt(database, input, publicUrl);

    if (wantsJson(request)) {
      return NextResponse.json({
        attemptId: created.attempt.id,
        expiresAt: created.attempt.expiresAt,
        githubRegistrationUrl: created.githubRegistrationUrl,
        manifest: created.manifest,
      });
    }
    return manifestForm(created.githubRegistrationUrl, created.manifest);
  } catch (error) {
    return errorResponse(error);
  }
}
