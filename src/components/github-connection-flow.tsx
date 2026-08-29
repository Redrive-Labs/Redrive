"use client";

import { useEffect, useRef, useState } from "react";

interface RepositoryChoice {
  id: string;
  fullName: string;
  private: boolean;
  defaultBranch: string | null;
}

interface WebhookChoice {
  id: string;
  name: string;
  targetDisplay: string;
  active: boolean;
  events: string[];
}

interface Connection {
  id: string;
  provider: "github";
  githubInstallationId: string;
  repositoryId: string;
  repositoryFullName: string;
  webhookId: string;
  webhookTargetDisplay: string;
  state: "READY";
  account?: { login: string; type: string };
}

interface ApiError {
  error?: string;
}

async function readJson<T>(response: Response): Promise<T | ApiError | null> {
  return (await response.json().catch(() => null)) as T | ApiError | null;
}

function errorMessage(value: unknown): string {
  return value !== null && typeof value === "object" && "error" in value &&
    typeof value.error === "string"
    ? value.error
    : "The GitHub connection request failed.";
}

export function GithubConnectionFlow() {
  const [installationId, setInstallationId] = useState<string | null>(null);
  const [repositories, setRepositories] = useState<RepositoryChoice[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookChoice[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [repositoryId, setRepositoryId] = useState("");
  const [webhookId, setWebhookId] = useState("");
  const [loadingRepositories, setLoadingRepositories] = useState(false);
  const [loadingWebhooks, setLoadingWebhooks] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState<Connection | null>(null);
  const webhookRequestGeneration = useRef(0);
  const activeWebhookSelection = useRef<{ installationId: string | null; repositoryId: string }>({
    installationId: null,
    repositoryId: "",
  });

  async function loadConnections() {
    const response = await fetch("/api/integrations/github/connections", {
      cache: "no-store",
    });
    const result = await readJson<{ connections: Connection[] }>(response);
    if (!response.ok) throw new Error(errorMessage(result));
    if (result !== null && "connections" in result && Array.isArray(result.connections)) {
      setConnections(result.connections);
    }
  }

  async function loadRepositories(nextInstallationId: string) {
    setLoadingRepositories(true);
    setError(null);
    try {
      const query = new URLSearchParams({ installationId: nextInstallationId });
      const response = await fetch(`/api/integrations/github/repositories?${query}`, {
        cache: "no-store",
      });
      const result = await readJson<{ repositories: RepositoryChoice[] }>(response);
      if (!response.ok) throw new Error(errorMessage(result));
      if (result === null || !("repositories" in result)) throw new Error("Repository response was invalid.");
      setRepositories(result.repositories);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Repositories could not be loaded.");
    } finally {
      setLoadingRepositories(false);
    }
  }

  useEffect(() => {
    const nextInstallationId = new URLSearchParams(window.location.search).get(
      "githubInstallationId",
    );
    let disposed = false;
    queueMicrotask(() => {
      if (disposed) return;
      void loadConnections().catch((reason: unknown) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "Connections could not be loaded.");
        }
      });
      if (nextInstallationId !== null && nextInstallationId.length > 0) {
        webhookRequestGeneration.current += 1;
        activeWebhookSelection.current = { installationId: nextInstallationId, repositoryId: "" };
        setInstallationId(nextInstallationId);
        void loadRepositories(nextInstallationId);
      }
    });
    return () => {
      disposed = true;
    };
  }, []);

  async function handleRepositoryChange(nextRepositoryId: string) {
    const requestGeneration = ++webhookRequestGeneration.current;
    const requestInstallationId = installationId;
    activeWebhookSelection.current = {
      installationId: requestInstallationId,
      repositoryId: nextRepositoryId,
    };
    const isCurrentRequest = () =>
      webhookRequestGeneration.current === requestGeneration &&
      activeWebhookSelection.current.installationId === requestInstallationId &&
      activeWebhookSelection.current.repositoryId === nextRepositoryId;

    setRepositoryId(nextRepositoryId);
    setWebhookId("");
    setWebhooks([]);
    if (requestInstallationId === null || nextRepositoryId.length === 0) {
      setLoadingWebhooks(false);
      return;
    }
    setLoadingWebhooks(true);
    setError(null);
    try {
      const query = new URLSearchParams({
        installationId: requestInstallationId,
        repositoryId: nextRepositoryId,
      });
      const response = await fetch(`/api/integrations/github/webhooks?${query}`, {
        cache: "no-store",
      });
      const result = await readJson<{ webhooks: WebhookChoice[] }>(response);
      if (!response.ok) throw new Error(errorMessage(result));
      if (result === null || !("webhooks" in result)) throw new Error("Webhook response was invalid.");
      if (isCurrentRequest()) setWebhooks(result.webhooks);
    } catch (reason) {
      if (isCurrentRequest()) {
        setError(reason instanceof Error ? reason.message : "Webhooks could not be loaded.");
      }
    } finally {
      if (isCurrentRequest()) setLoadingWebhooks(false);
    }
  }

  async function handleConnect(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (installationId === null || repositoryId.length === 0 || webhookId.length === 0) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/integrations/github/connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId, repositoryId, webhookId }),
      });
      const result = await readJson<{ connection: Connection }>(response);
      if (!response.ok || result === null || !("connection" in result)) {
        throw new Error(errorMessage(result));
      }
      setConnected(result.connection);
      await loadConnections();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The connection could not be saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-b border-[var(--line)] py-10" id="github-connection">
      <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start lg:gap-14">
        <div>
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--accent-deep)]">
            Application connection
          </p>
          <h2 className="display-type mt-2 text-4xl leading-none">Connect GitHub</h2>
          <p className="mt-4 max-w-xl text-sm leading-6 text-[var(--muted)]">
            Redrive creates a private, read-only-content GitHub App for this deployment.
            It protects an existing repository webhook; it does not receive webhook events.
          </p>
        </div>

        <div className="grid gap-5">
          <form action="/api/integrations/github/app-manifest" className="grid gap-3 border border-[var(--line)] bg-[var(--paper-bright)] p-4" method="post">
            <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-target-type">
              GitHub account target
              <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-target-type" name="targetType" defaultValue="personal" onChange={(event) => {
                const organization = document.getElementById("github-organization-login");
                if (organization instanceof HTMLInputElement) organization.hidden = event.target.value !== "organization";
              }}>
                <option value="personal">Personal account</option>
                <option value="organization">GitHub organization</option>
              </select>
            </label>
            <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-organization-login">
              Organization login
              <input className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-organization-login" name="ownerLogin" placeholder="acme" hidden />
            </label>
            <button className="min-h-11 bg-[var(--ink)] px-4 text-sm font-semibold text-[var(--paper-bright)] hover:bg-[var(--accent-deep)]" type="submit">
              Create GitHub App
            </button>
          </form>

          {installationId !== null ? (
            <form className="grid gap-3 border border-[var(--line)] bg-[var(--paper-bright)] p-4" onSubmit={handleConnect}>
              <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Installation verified</p>
              <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-repository">
                Repository
                <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-repository" value={repositoryId} onChange={(event) => void handleRepositoryChange(event.target.value)}>
                  <option value="">{loadingRepositories ? "Loading repositories…" : "Choose a repository"}</option>
                  {repositories.map((repository) => <option key={repository.id} value={repository.id}>{repository.fullName}</option>)}
                </select>
              </label>
              <label className="grid gap-1.5 text-sm font-semibold" htmlFor="github-webhook">
                Existing webhook
                <select className="min-h-11 border border-[var(--line)] bg-[var(--paper-bright)] px-3 text-sm font-normal" id="github-webhook" value={webhookId} onChange={(event) => setWebhookId(event.target.value)} disabled={repositoryId.length === 0 || loadingWebhooks}>
                  <option value="">{loadingWebhooks ? "Loading webhooks…" : "Choose a webhook"}</option>
                  {webhooks.map((webhook) => <option key={webhook.id} value={webhook.id}>{webhook.targetDisplay}</option>)}
                </select>
              </label>
              <button className="min-h-11 bg-[var(--accent)] px-4 text-sm font-semibold text-[var(--paper-bright)] disabled:cursor-not-allowed disabled:opacity-50" disabled={saving || webhookId.length === 0} type="submit">
                {saving ? "Saving connection…" : "Save connection"}
              </button>
            </form>
          ) : null}

          {error ? <p className="border border-[#d89d89] bg-[var(--accent-wash)] px-3 py-2 text-sm text-[var(--accent-deep)]" role="alert">{error}</p> : null}
          {connected ? <p className="border border-[var(--line)] bg-[var(--accent-wash)] px-3 py-2 text-sm" role="status">Connected: {connected.repositoryFullName} · {connected.webhookTargetDisplay}</p> : null}
        </div>
      </div>

      {connections.length > 0 ? (
        <div className="mt-8 border-t border-[var(--line)] pt-6">
          <p className="mono-type text-[10px] uppercase tracking-[0.16em] text-[var(--muted)]">Durable connections</p>
          <ul className="mt-3 grid gap-2">
            {connections.map((connection) => <li className="flex flex-wrap items-baseline justify-between gap-3 border-b border-[var(--line)] py-3 text-sm" key={connection.id}>
              <span><strong>{connection.account?.login ?? "GitHub"}</strong> · {connection.repositoryFullName}</span>
              <span className="mono-type text-xs text-[var(--muted)]">{connection.state} · {connection.webhookTargetDisplay}</span>
            </li>)}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
